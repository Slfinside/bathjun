using System;
using System.Runtime.InteropServices;
using System.Threading;

// Windows HumanPresenceSensor ABI (IInspectable slots from the Windows SDK).
// Uses a dedicated background apartment; never opens a camera, identifies a
// person, stores readings, or changes Windows privacy/power settings.
internal sealed class HumanPresenceReader : IDisposable {
    [DllImport("combase.dll")] static extern int RoInitialize(uint type);
    [DllImport("combase.dll")] static extern void RoUninitialize();
    [DllImport("combase.dll",CharSet=CharSet.Unicode)] static extern int WindowsCreateString(string text,uint length,out IntPtr value);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr value);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name,ref Guid iid,out IntPtr factory);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PointerCall(IntPtr self,out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumCall(IntPtr self,out int result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int BoolCall(IntPtr self,out byte result);
    readonly ManualResetEvent stopped=new ManualResetEvent(false);
    Thread worker;volatile bool absent,present;volatile string status="人感センサー：準備中";
    public bool IsPresent {get{return present;}}
    public bool NotPresent {get{return absent;}}
    public string Status {get{return status;}}
    static T Slot<T>(IntPtr instance,int index) where T:class {
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance),index*IntPtr.Size),typeof(T)) as T;
    }
    static void Check(int code){Marshal.ThrowExceptionForHR(code);}
    public void Start(){if(worker!=null)return;worker=new Thread(Run){IsBackground=true};worker.SetApartmentState(ApartmentState.MTA);worker.Start();}
    void Run() {
        IntPtr name=IntPtr.Zero,factory=IntPtr.Zero,sensor=IntPtr.Zero,capability=IntPtr.Zero;
        bool initialized=false;
        try {
            int hr=RoInitialize(1);Check(hr);initialized=true;
            const string type="Windows.Devices.Sensors.HumanPresenceSensor";
            Check(WindowsCreateString(type,(uint)type.Length,out name));
            var iid=new Guid("5de35843-d260-5a87-995e-ace91326e1c4"); // IHumanPresenceSensorStatics2
            Check(RoGetActivationFactory(name,ref iid,out factory));
            Check(Slot<PointerCall>(factory,7)(factory,out sensor)); // GetDefault
            if(sensor==IntPtr.Zero){status="人感センサー：対応センサーなし（通常表示）";return;}
            var supportId=new Guid("f8833779-65fe-541a-b9d6-1e474a485e7a");
            Check(Marshal.QueryInterface(sensor,ref supportId,out capability));
            byte supported;Check(Slot<BoolCall>(capability,6)(capability,out supported));
            if(supported==0){status="人感センサー：在席検知非対応（通常表示）";return;}
            do {
                IntPtr reading=IntPtr.Zero;
                try {
                    Check(Slot<PointerCall>(sensor,9)(sensor,out reading)); // GetCurrentReading
                    if(reading==IntPtr.Zero){absent=false;status="人感センサー：判定待ち（通常表示）";}
                    else {
                        int value;Check(Slot<EnumCall>(reading,7)(reading,out value)); // Presence: Unknown=0, Present=1, NotPresent=2
                        absent=value==2;present=value==1;
                        status=value==1?"人感センサー：在席 · 明るい表示":value==2?"人感センサー：不在 · 暗い表示":"人感センサー：判定不能（通常表示）";
                    }
                } finally {if(reading!=IntPtr.Zero)Marshal.Release(reading);}
            } while(!stopped.WaitOne(2000));
        } catch {absent=false;present=false;status="人感センサー：利用できません（通常表示）";}
        finally {
            if(capability!=IntPtr.Zero)Marshal.Release(capability);
            if(sensor!=IntPtr.Zero)Marshal.Release(sensor);
            if(factory!=IntPtr.Zero)Marshal.Release(factory);
            if(name!=IntPtr.Zero)WindowsDeleteString(name);
            if(initialized)RoUninitialize();
            // Event stays alive until the last outstanding wait has finished.
            // Kept until the reader is collected: Dispose may race with completion.
        }
    }
    public void Dispose(){if(worker==null)stopped.Dispose();else stopped.Set();}
}
