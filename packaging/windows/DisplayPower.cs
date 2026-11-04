using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

// State and policy are independent of WinForms and Windows calls, so tests can
// simulate a successful API call which never actually changes the panel state.
public sealed class DisplayPlan {
    public bool Managed,On;public DateTime? WakeAt;
}
public sealed class DisplayPowerPolicy {
    bool manual,wasScheduled;uint? inputAtOff;DateTime? armAt;
    DateTime holdUntil=DateTime.MinValue;
    public bool Manual {get{return manual||armAt.HasValue;}}
    public void RequestOff(DateTime utc){holdUntil=DateTime.MinValue;armAt=utc.AddSeconds(1);}
    public void RequestOn(DateTime utc){manual=false;armAt=null;holdUntil=utc.AddSeconds(60);}
    public DisplayPlan Evaluate(DisplaySchedulePreferences preference,DateTime utc,bool eligible,bool dashboard,uint idle,uint? input){
        bool scheduled=eligible&&preference.IsOffTime(utc);
        if(!eligible){manual=false;armAt=null;}
        if(wasScheduled&&!scheduled)manual=false;
        wasScheduled=scheduled;
        if(armAt.HasValue&&utc>=armAt.Value){armAt=null;manual=eligible&&input.HasValue;inputAtOff=input;}
        if(manual&&inputAtOff.HasValue&&input.HasValue&&inputAtOff.Value!=input.Value)RequestOn(utc);
        bool off=eligible&&input.HasValue&&utc>=holdUntil&&(manual||(scheduled&&idle>=60));
        return new DisplayPlan{Managed=(eligible&&(preference.enabled||dashboard||Manual))||utc<holdUntil,On=!off,WakeAt=off&&scheduled?preference.NextOn(utc):null};
    }
}
public interface IDisplayPowerDriver {
    bool SetDisplayLease(bool on);
    bool Command(bool on);
    bool SetWakeTimer(DateTime? utc);
}
public sealed class DisplayTransition {
    public int? Observed {get;private set;}
    public bool? Desired {get;private set;}
    public bool Failed {get;private set;}
    public string Error {get;private set;}
    public bool Confirmed {get{return Desired.HasValue&&Observed.HasValue&&Observed.Value==(Desired.Value?1:0);}}
    int attempts;DateTime retryAt=DateTime.MinValue;bool? lease;
    public void Observe(int value){if(value<0||value>2)return;Observed=value;if(Confirmed){Failed=false;Error=null;attempts=0;}}
    public void Refresh(){Observed=null;Desired=null;attempts=0;retryAt=DateTime.MinValue;lease=null;Failed=false;Error=null;}
    public void Apply(DisplayPlan plan,DateTime utc,IDisplayPowerDriver driver){
        // Arm the restoration before the first off command. A missing timer must
        // never leave a scheduled screen with no path back to an on request.
        bool timer=driver.SetWakeTimer(plan.WakeAt);
        bool on=plan.On||!timer;
        if(Desired!=(plan.Managed?(bool?)on:null)){Desired=plan.Managed?(bool?)on:null;attempts=0;retryAt=DateTime.MinValue;Failed=false;Error=null;}
        bool keep=plan.Managed&&on;
        if(lease!=keep){if(!driver.SetDisplayLease(keep)){Failed=true;Error="画面の電源要求を設定できませんでした。";return;}lease=keep;}
        if(!timer){Failed=true;Error="自動点灯のタイマーを登録できないため、消灯しません。";}
        if(!Desired.HasValue||Confirmed||utc<retryAt)return;
        if(attempts>=3){Failed=true;if(Error==null)Error=on?"点灯を確認できません。診断ログを確認してください。":"消灯を確認できません。診断ログを確認してください。";return;}
        attempts++;retryAt=utc.AddSeconds(5);
        bool accepted=driver.Command(on);
        // An accepted command is not an acknowledgement. Only Observe() can
        // confirm the transition; retries also cover ignored monitor messages.
        if(!accepted){Failed=true;Error=on?"点灯要求に失敗しました。再試行します。":"消灯要求に失敗しました。再試行します。";}
    }
}
public sealed class DisplayPowerSnapshot {
    public bool Protected,Managed,On=true,Confirmed,Failed,TimerArmed;
    public int? Observed;public string Error;public DateTime? WakeAt;public int PowerEpoch;
}
// A dedicated, lightweight message-loop thread owns all GUI display requests,
// power notifications and the native wake timer. The main UI never powers a
// display itself, and a busy main UI cannot miss a scheduled on boundary.
internal sealed class WindowsDisplayService : IDisposable {
    readonly object gate=new object();readonly Thread thread;readonly ManualResetEvent initialized=new ManualResetEvent(false);
    Control dispatcher;ApplicationContext context;DisplayWindow window;System.Windows.Forms.Timer tick;
    DisplaySchedulePreferences preference=new DisplaySchedulePreferences();bool ready,dashboard,stopping;
    readonly DisplayPowerPolicy policy=new DisplayPowerPolicy();readonly DisplayTransition transition=new DisplayTransition();
    NativeDisplayDriver driver;DisplayPowerSnapshot snapshot=new DisplayPowerSnapshot();int epoch;bool faulted;
    readonly string logPath;string lastLog="";
    public WindowsDisplayService(){
        string directory=Environment.GetEnvironmentVariable("BATHJUN_DATA_DIR")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"BathjunData");
        logPath=Path.Combine(directory,"display-power.log");
        thread=new Thread(Run){IsBackground=true,Name="Bathjun display power"};thread.SetApartmentState(ApartmentState.STA);thread.Start();
    }
    public string LogPath {get{return logPath;}}
    public DisplayPowerSnapshot Snapshot {get{lock(gate)return snapshot;}}
    void Post(Action work){lock(gate){if(stopping)return;}try{if(!initialized.WaitOne(0))return;dispatcher.BeginInvoke((MethodInvoker)delegate{try{work();Step();}catch(Exception error){Fail(error);}});}catch(InvalidOperationException){}}
    public void Update(DisplaySchedulePreferences value,bool canOperate,bool dashboardVisible){
        lock(gate){preference=new DisplaySchedulePreferences{enabled=value.enabled,periods=Array.ConvertAll(value.periods,p=>new DisplayOffPeriod{start=p.start,end=p.end})};ready=canOperate;dashboard=dashboardVisible;}
    }
    public void RequestOff(){Post(()=>policy.RequestOff(DateTime.UtcNow));}
    public void RequestOn(){Post(()=>policy.RequestOn(DateTime.UtcNow));}
    public void Renew(){Post(RenewCore);}
    void RenewCore(){try{policy.RequestOn(DateTime.UtcNow);driver.Renew();transition.Refresh();window.RefreshSubscription();faulted=false;epoch++;Log("power renewed");if(tick!=null)tick.Start();}catch(Exception error){Fail(error);}}
    void Run(){
        try{
            dispatcher=new Control();if(dispatcher.Handle==IntPtr.Zero)throw new InvalidOperationException("Display dispatcher unavailable");
            context=new ApplicationContext();
            window=new DisplayWindow(value=>{transition.Observe(value);Log("observed="+value);Step();},()=>{if(driver!=null){RenewCore();Step();}},value=>Log(value));
            driver=new NativeDisplayDriver(window.Handle,Log,()=>Post(()=>{if(driver.WakeAt.HasValue&&driver.WakeAt.Value<=DateTime.UtcNow){Log("wake timer fired");policy.RequestOn(DateTime.UtcNow);}}));
            initialized.Set();tick=new System.Windows.Forms.Timer{Interval=500};tick.Tick+=delegate{Step();};tick.Start();Step();Application.Run(context);
        }catch(Exception error){lock(gate)snapshot=new DisplayPowerSnapshot{Failed=true,Error="画面制御を開始できませんでした："+error.GetType().Name};Log("service error="+error.GetType().Name);initialized.Set();}
        finally{
            if(tick!=null){tick.Stop();tick.Dispose();}
            if(driver!=null){bool restore=transition.Desired.HasValue;driver.SetWakeTimer(null);if(restore){driver.SetDisplayLease(true);driver.Command(true);}driver.Dispose();}
            if(window!=null)window.Dispose();if(dispatcher!=null)dispatcher.Dispose();
        }
    }
    void Fail(Exception error){
        if(faulted)return;faulted=true;policy.RequestOn(DateTime.UtcNow);transition.Refresh();
        if(tick!=null)tick.Stop();Log("control error="+error.GetType().Name);
        try{if(driver!=null){driver.SetWakeTimer(null);driver.SetDisplayLease(true);driver.Command(true);}}catch{}
        lock(gate)snapshot=new DisplayPowerSnapshot{Failed=true,Error="画面制御でエラーが発生しました。診断ログを確認してください。",PowerEpoch=epoch};
    }
    void Step(){try{StepCore();}catch(Exception error){Fail(error);}}
    void StepCore(){
        if(driver==null||faulted)return;
        DisplaySchedulePreferences settings;bool eligible,visible;
        lock(gate){settings=preference;eligible=ready;visible=dashboard;}
        bool protectedState=driver.Protected;
        eligible=eligible&&protectedState&&window.Registered;
        var plan=policy.Evaluate(settings,DateTime.UtcNow,eligible,visible,PowerLease.IdleSeconds(),PowerLease.LastInputTick());
        // Losing the server or AC must request restoration, even if no automatic
        // period is enabled and the main window is minimized.
        if(!eligible&&transition.Desired==false){policy.RequestOn(DateTime.UtcNow);plan=policy.Evaluate(settings,DateTime.UtcNow,false,visible,0,PowerLease.LastInputTick());}
        transition.Apply(plan,DateTime.UtcNow,driver);
        var current=new DisplayPowerSnapshot{Protected=protectedState&&window.Registered,Managed=plan.Managed,On=transition.Desired??true,Confirmed=transition.Confirmed,Observed=transition.Observed,Failed=transition.Failed,Error=transition.Error,TimerArmed=driver.TimerArmed,WakeAt=driver.WakeAt,PowerEpoch=epoch};
        if(!window.Registered){current.Failed=true;current.Error="画面状態の通知を登録できないため、消灯を無効にしました。";}
        lock(gate)snapshot=current;
        string state="desired="+(transition.Desired.HasValue?(transition.Desired.Value?"on":"off"):"unmanaged")+" observed="+(current.Observed.HasValue?current.Observed.Value.ToString():"unknown")+" confirmed="+current.Confirmed+" timer="+(current.WakeAt.HasValue?current.WakeAt.Value.ToString("o"):"none")+" protected="+current.Protected+" error="+(current.Error??"none");
        if(state!=lastLog){lastLog=state;Log(state);}
    }
    void Log(string value){try{Directory.CreateDirectory(Path.GetDirectoryName(logPath));if(File.Exists(logPath)&&new FileInfo(logPath).Length>128*1024){string old=logPath+".1";if(File.Exists(old))File.Delete(old);File.Move(logPath,old);}File.AppendAllText(logPath,DateTime.UtcNow.ToString("o")+" "+value+Environment.NewLine);}catch{}}
    public void Dispose(){
        lock(gate){if(stopping)return;stopping=true;}
        if(initialized.WaitOne(2000)&&dispatcher!=null)try{dispatcher.BeginInvoke((MethodInvoker)delegate{context.ExitThread();});}catch(InvalidOperationException){}
        if(thread.Join(3000))initialized.Dispose(); // Native sends are bounded; never wait indefinitely on shutdown.
    }
    sealed class DisplayWindow : NativeWindow,IDisposable {
        static readonly Guid DisplayGuid=new Guid("6fe69556-704a-47a0-8f24-c28d936fda47");
        readonly Action<int> observed;readonly Action resumed;readonly Action<string> diagnostic;IntPtr registration;bool sessionRegistered;
        [DllImport("user32.dll",SetLastError=true)]static extern IntPtr RegisterPowerSettingNotification(IntPtr hwnd,ref Guid setting,int flags);
        [DllImport("user32.dll")]static extern bool UnregisterPowerSettingNotification(IntPtr handle);
        public bool Registered {get{return registration!=IntPtr.Zero;}}
        [DllImport("wtsapi32.dll",SetLastError=true)]static extern bool WTSRegisterSessionNotification(IntPtr hwnd,uint flags);
        [DllImport("wtsapi32.dll")]static extern bool WTSUnRegisterSessionNotification(IntPtr hwnd);
        public DisplayWindow(Action<int> observed,Action resumed,Action<string> diagnostic){this.observed=observed;this.resumed=resumed;this.diagnostic=diagnostic;CreateHandle(new CreateParams{Caption="Bathjun display notifications"});var setting=DisplayGuid;registration=RegisterPowerSettingNotification(Handle,ref setting,0);sessionRegistered=WTSRegisterSessionNotification(Handle,0);}
        public void RefreshSubscription(){if(registration!=IntPtr.Zero)UnregisterPowerSettingNotification(registration);var setting=DisplayGuid;registration=RegisterPowerSettingNotification(Handle,ref setting,0);}
        protected override void WndProc(ref Message message){
            if(message.Msg==0x218){int kind=message.WParam.ToInt32();
                if(kind==0x8013&&message.LParam!=IntPtr.Zero){var setting=(Guid)Marshal.PtrToStructure(message.LParam,typeof(Guid));if(setting==DisplayGuid&&Marshal.ReadInt32(message.LParam,16)==4)observed(Marshal.ReadInt32(message.LParam,20));}
                else if(kind==7||kind==18||kind==10){diagnostic("power resume/status="+kind);resumed();}else if(kind==4)diagnostic("system suspend observed");
            }
            if(message.Msg==0x2b1&&(message.WParam.ToInt32()==7||message.WParam.ToInt32()==8))diagnostic(message.WParam.ToInt32()==7?"session locked":"session unlocked");
            base.WndProc(ref message);
        }
        public void Dispose(){if(registration!=IntPtr.Zero)UnregisterPowerSettingNotification(registration);registration=IntPtr.Zero;if(sessionRegistered)WTSUnRegisterSessionNotification(Handle);DestroyHandle();}
    }
    sealed class NativeDisplayDriver : IDisplayPowerDriver,IDisposable {
        readonly IntPtr hwnd;readonly Action wake;readonly Action<string> log;readonly PowerLease lease=new PowerLease();
        WaitHandle timer;RegisteredWaitHandle waiter;DateTime? due;int generation;
        sealed class TimerHandle:WaitHandle {public TimerHandle(IntPtr handle){SafeWaitHandle=new SafeWaitHandle(handle,true);}}
        public bool Protected {get;private set;}
        public bool TimerArmed {get{return due.HasValue;}}
        public DateTime? WakeAt {get{return due;}}
        [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint msg,UIntPtr wp,IntPtr lp,uint flags,uint timeout,out UIntPtr result);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateWaitableTimer(IntPtr attributes,bool manualReset,string name);
        [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetWaitableTimer(IntPtr timer,ref long due,int period,IntPtr routine,IntPtr argument,bool resume);
        [DllImport("kernel32.dll")]static extern bool CancelWaitableTimer(IntPtr timer);
        public NativeDisplayDriver(IntPtr hwnd,Action<string> log,Action wake){this.hwnd=hwnd;this.log=log;this.wake=wake;Renew();}
        public void Renew(){Protected=lease.Acquire();log("process protection="+Protected);}
        public bool SetDisplayLease(bool on){return lease.SetDisplay(on);}
        public bool Command(bool on){
            if(on&&!lease.PulseDisplay()){log("wake pulse failed");return false;}
            UIntPtr result;bool accepted=SendMessageTimeout(hwnd,0x0112,new UIntPtr(0xf170),new IntPtr(on?-1:2),0x0002,1000,out result)!=IntPtr.Zero;
            log("command="+(on?"on":"off")+" accepted="+accepted+" error="+(accepted?0:Marshal.GetLastWin32Error()));return accepted;
        }
        public bool SetWakeTimer(DateTime? utc){
            if(due==utc)return true;
            int version=Interlocked.Increment(ref generation);
            if(timer!=null){CancelWaitableTimer(timer.SafeWaitHandle.DangerousGetHandle());if(waiter!=null)waiter.Unregister(null);timer.Dispose();timer=null;waiter=null;}
            due=null;if(!utc.HasValue)return true;
            IntPtr handle=CreateWaitableTimer(IntPtr.Zero,false,null);if(handle==IntPtr.Zero)return false;
            timer=new TimerHandle(handle);
            long fileTime=utc.Value.ToUniversalTime().ToFileTimeUtc();
            if(!SetWaitableTimer(handle,ref fileTime,0,IntPtr.Zero,IntPtr.Zero,true)){timer.Dispose();timer=null;return false;}
            due=utc;log("native wake timer="+utc.Value.ToString("o"));waiter=ThreadPool.RegisterWaitForSingleObject(timer,delegate{if(Volatile.Read(ref generation)==version)wake();},null,Timeout.Infinite,true);return true;
        }
        public void Dispose(){SetWakeTimer(null);lease.Dispose();}
    }
}
