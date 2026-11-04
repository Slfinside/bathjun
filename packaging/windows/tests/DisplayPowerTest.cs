using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class DisplayPowerTest {
    sealed class Driver:IDisplayPowerDriver {
        public int Off,On;public bool TimerOK=true,LeaseOK=true,CommandOK=true;public readonly List<string> Events=new List<string>();
        public DateTime? Wake;
        public bool SetDisplayLease(bool on){Events.Add(on?"lease-on":"lease-off");return LeaseOK;}
        public bool Command(bool on){Events.Add(on?"on":"off");if(on)On++;else Off++;return CommandOK;}
        public bool SetWakeTimer(DateTime? due){Wake=due;Events.Add(due.HasValue?"timer-armed":"timer-clear");return TimerOK;}
    }
    static void Check(bool value,string message){if(!value)throw new Exception(message);}
    static DateTime Japan(string value){return DateTime.SpecifyKind(DateTime.ParseExact(value,"yyyy-MM-dd HH:mm:ss",System.Globalization.CultureInfo.InvariantCulture),DateTimeKind.Utc).AddHours(-9);}
    static void Boundaries(){
        var preference=new DisplaySchedulePreferences{enabled=true};var policy=new DisplayPowerPolicy();
        var off=policy.Evaluate(preference,Japan("2026-11-04 08:00:00"),true,true,60,10);
        Check(off.Managed&&!off.On&&off.WakeAt==Japan("2026-11-04 15:00:00"),"Scheduled restoration was not computed before screen off");
        Check(policy.Evaluate(preference,Japan("2026-11-04 15:00:00"),true,true,20000,10).On,"End boundary did not request on");
        var overlap=new DisplaySchedulePreferences{enabled=true,periods=new[]{new DisplayOffPeriod{start=1380,end=360},new DisplayOffPeriod{start=300,end=480}}};
        Check(overlap.NextOn(Japan("2026-11-04 23:30:00"))==Japan("2026-11-05 08:00:00"),"Overnight merged intervals woke too early");
        var allDay=new DisplaySchedulePreferences{enabled=true,periods=new[]{new DisplayOffPeriod{start=0,end=720},new DisplayOffPeriod{start=720,end=0}}};
        Check(!allDay.NextOn(DateTime.UtcNow).HasValue,"Full-day schedule invented an on boundary");
        Check(policy.Evaluate(preference,Japan("2026-11-04 10:00:00"),true,true,20,10).On,"Recent input was ignored");
        Check(policy.Evaluate(preference,Japan("2026-11-04 10:00:00"),true,true,100,null).On,"Input tracking failure allowed off");
        Check(policy.Evaluate(preference,Japan("2026-11-04 10:00:00"),false,true,100,10).On,"Loss of eligibility did not request on");
        Check(!policy.Evaluate(preference,Japan("2026-11-04 10:00:00"),false,true,100,10).Managed,"Ineligible server retained dashboard display control");
    }
    static void Manual(){
        var policy=new DisplayPowerPolicy();var preference=new DisplaySchedulePreferences();var now=Japan("2026-11-04 10:00:00");
        policy.RequestOff(now);Check(policy.Evaluate(preference,now,true,true,0,10).On,"Button tap was not allowed to settle");
        Check(!policy.Evaluate(preference,now.AddSeconds(1),true,true,0,10).On,"Manual off did not override dashboard keep-awake");
        Check(!policy.Evaluate(preference,now.AddSeconds(10),true,true,10,10).On,"Dashboard power request undid manual off");
        Check(policy.Evaluate(preference,now.AddSeconds(11),true,true,0,11).On,"New touch did not restore display");
        Check(policy.Evaluate(preference,now.AddSeconds(12),true,false,1,11).Managed,"Wake had no retained display lease");
        policy.RequestOff(now.AddSeconds(20));Check(!policy.Evaluate(preference,now.AddSeconds(21),true,false,0,11).On,"Explicit off was blocked by the touch wake grace");
        policy.RequestOn(now.AddSeconds(22));Check(policy.Evaluate(preference,now.AddSeconds(22),true,false,0,11).On,"Explicit wake did not override manual off");
        var scheduled=new DisplaySchedulePreferences{enabled=true};policy.RequestOff(now);policy.Evaluate(scheduled,now.AddSeconds(1),true,true,0,12);
        Check(policy.Evaluate(scheduled,Japan("2026-11-04 15:00:00"),true,true,18000,12).On&&!policy.Manual,"Automatic on did not cancel manual off");
    }
    static void Acknowledgements(){
        var now=DateTime.UtcNow;var driver=new Driver();var state=new DisplayTransition();
        var off=new DisplayPlan{Managed=true,On=false,WakeAt=now.AddHours(1)};
        state.Observe(1);state.Apply(off,now,driver);
        Check(driver.Off==1&&!state.Confirmed,"Successful API call was falsely treated as screen-off confirmation");
        Check(driver.Events[0]=="timer-armed"&&driver.Events[1]=="lease-off"&&driver.Events[2]=="off","Restoration timer/lease ordering is unsafe");
        state.Apply(off,now.AddSeconds(5),driver);state.Apply(off,now.AddSeconds(10),driver);state.Apply(off,now.AddSeconds(15),driver);
        Check(driver.Off==3&&state.Failed&&!state.Confirmed,"Ignored off command was not bounded and reported");
        state.Observe(0);Check(state.Confirmed&&!state.Failed,"Observed off did not acknowledge pending request");
        var on=new DisplayPlan{Managed=true,On=true};state.Apply(on,now.AddSeconds(16),driver);
        Check(driver.On==1&&!state.Confirmed&&driver.Wake==null,"Wake was not retained pending real observation");
        state.Apply(on,now.AddSeconds(21),driver);Check(driver.On==2,"Accepted-but-ignored wake was not retried");
        state.Observe(1);Check(state.Confirmed&&!state.Failed,"Observed on did not acknowledge wake");
        state.Apply(on,now.AddSeconds(30),driver);Check(driver.On==2,"Confirmed on was repeatedly commanded");
        state.Refresh();state.Apply(on,now.AddSeconds(31),driver);Check(driver.On==3&&!state.Confirmed,"Resume did not invalidate stale confirmation");
    }
    static void Failures(){
        var now=DateTime.UtcNow;var off=new DisplayPlan{Managed=true,On=false,WakeAt=now.AddHours(1)};
        var driver=new Driver{TimerOK=false};var state=new DisplayTransition();state.Apply(off,now,driver);
        Check(driver.Off==0&&driver.On==1&&state.Desired==true&&state.Failed,"Failed wake timer still allowed physical off");
        driver=new Driver{LeaseOK=false};state=new DisplayTransition();state.Apply(off,now,driver);Check(driver.Off==0&&state.Failed,"Failed display lease still allowed off");
        driver=new Driver{CommandOK=false};state=new DisplayTransition();state.Apply(off,now,driver);Check(state.Failed&&!state.Confirmed,"Native failure was hidden");
        driver=new Driver();state=new DisplayTransition();state.Observe(0);state.Apply(new DisplayPlan{Managed=true,On=true},now,driver);
        Check(driver.Events[1]=="lease-on"&&driver.Events[2]=="on","Wake lost the persistent display requirement");
        state.Observe(2);Check(!state.Confirmed,"Dim was falsely treated as full on");
        state.Apply(new DisplayPlan{Managed=false,On=true},now.AddSeconds(1),driver);Check(!state.Desired.HasValue,"Unmanaged Windows display state was overridden");
    }
    static void Worker(){
        // Start the actual hidden observer and power lease, without enabling a
        // schedule, a dashboard or manual commands. Never switch a CI monitor.
        string previous=Environment.GetEnvironmentVariable("BATHJUN_DATA_DIR"),folder=Path.Combine(Path.GetTempPath(),"bathjun-power-worker-"+Guid.NewGuid().ToString("N"));
        Environment.SetEnvironmentVariable("BATHJUN_DATA_DIR",folder);
        try{
            var type=typeof(Member).Assembly.GetType("WindowsDisplayService");
            var service=(IDisposable)Activator.CreateInstance(type);
            using(service){
                var property=type.GetProperty("Snapshot");DisplayPowerSnapshot value=null;
                for(int i=0;i<100;i++){value=(DisplayPowerSnapshot)property.GetValue(service,null);if(value.Protected||value.Failed)break;Thread.Sleep(50);}
                Check(value.Protected,"Actual Windows notification/power worker failed to initialize: "+value.Error);
                Check(!value.Managed&&!value.TimerArmed,"Idle service took ownership of screen or armed wake");
            }
            Check(!((Thread)type.GetField("thread",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(service)).IsAlive,"Display worker did not stop");
            if(File.Exists(Path.Combine(folder,"display-power.log"))){string log=File.ReadAllText(Path.Combine(folder,"display-power.log"));Check(!log.Contains("/family/")&&!log.Contains("https://"),"Power log exposed private family data");}
        }finally{Environment.SetEnvironmentVariable("BATHJUN_DATA_DIR",previous);if(Directory.Exists(folder))Directory.Delete(folder,true);}
    }
    [STAThread] static void Main(){Boundaries();Manual();Acknowledgements();Failures();Worker();Console.WriteLine("Display power passed: real acknowledgements, retained wake lease, bounded retries, safe timer ordering, manual/schedule boundaries and isolated Windows worker. No physical display commands were used.");}
}
