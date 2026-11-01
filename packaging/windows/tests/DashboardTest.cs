using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
// Render without showing the form: no power requests, sensor access or live IPC.
internal static class DashboardTest {
    static void Set(object target,string name,object value){target.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).SetValue(target,value);}
    static object Get(object target,string name){return target.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).GetValue(target);}
    static void Call(object target,string name,params object[] values){target.GetType().GetMethod(name,BindingFlags.Instance|BindingFlags.NonPublic).Invoke(target,values);}
    static bool ClickSave(Control root){foreach(Control control in root.Controls){if(control is Button&&control.Text=="表示設定を保存"){typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(control,new object[]{EventArgs.Empty});return true;}if(ClickSave(control))return true;}return false;}
    static void Preferences(string screenshots){
        string previous=Environment.GetEnvironmentVariable("BATHJUN_DATA_DIR"),folder=Path.Combine(Path.GetTempPath(),"bathjun-display-test-"+Guid.NewGuid().ToString("N"));
        Environment.SetEnvironmentVariable("BATHJUN_DATA_DIR",folder);
        try{
            var value=DashboardPreferences.Read();if(value.fixedDetails||value.returnMinutes!=1)throw new Exception("Invalid default display preferences");
            var panelType=typeof(Member).Assembly.GetType("PanelForm");
            var panel=(Form)Activator.CreateInstance(panelType,new object[]{"test-pipe","test-token",false});
            try{
                Set(panel,"powerHeld",true);Set(panel,"serverPowerHeld",false);var protectedState=panelType.GetProperty("SleepProtectionReady",BindingFlags.Instance|BindingFlags.NonPublic);if((bool)protectedState.GetValue(panel,null))throw new Exception("GUI request alone enabled screen off");Set(panel,"serverPowerHeld",true);if(!(bool)protectedState.GetValue(panel,null))throw new Exception("Server power request was ignored");Set(panel,"powerHeld",false);Set(panel,"serverPowerHeld",false);
                ((CheckBox)Get(panel,"dashboardFixed")).Checked=true;((NumericUpDown)Get(panel,"dashboardMinutes")).Value=7;
                if(((NumericUpDown)Get(panel,"dashboardMinutes")).Enabled)throw new Exception("Fixed mode did not disable timeout input");
                ((CheckBox)Get(panel,"automaticDisplay")).Checked=true;
                ClickSave(panel);
                var periods=DisplaySchedulePreferences.Read();if(!periods.enabled||periods.periods[0].start!=480||periods.periods[0].end!=900)throw new Exception("Display schedule UI did not save periods");
                var grid=(DataGridView)Get(panel,"displayPeriods");grid.Rows[0].Cells["Start"].Value="not-a-time";bool rejected=false;try{Call(panel,"ReadDisplayScheduleInput");}catch(TargetInvocationException){rejected=true;}if(!rejected)throw new Exception("Display schedule UI accepted invalid time");grid.Rows[0].Cells["Start"].Value="08:00";
                var counts=new Dictionary<string,int>{{"skip",1},{"extend",1},{"boost",1},{"guard",2}};var weights=new Dictionary<string,int>{{"skip",1},{"extend",1},{"boost",1},{"guard",1}};
                Call(panel,"FillRewards",new RewardsAdmin{settings=new RewardSettings{standbyFailureDays=3,clientReportMinutes=10,dashboardReportMinutes=5,extensionMinutes=30,boostDraws=3,rewardMode="fixed",fixedKind="guard",fixedQuantity=2,extensionBlocked=true,extensionBlockedStart=1140,extensionBlockedEnd=1380,extensionNoticeMinutes=120,skipNoticeMinutes=120,quantities=counts,weights=weights},members=new[]{new ItemMember{id=1,name="テスト利用者",wallet=new[]{new ItemCount{kind="guard",quantity=2}}}},history=new GiftRecord[0]});
                if(!((CheckBox)Get(panel,"extensionBlocked")).Checked||((NumericUpDown)Get(panel,"extensionNotice")).Value!=120||((DateTimePicker)Get(panel,"extensionBlockedStart")).Value.Hour!=19)throw new Exception("Ticket limits not loaded into controls");
                if(((NumericUpDown)Get(panel,"standbyFailureDays")).Value!=3||((NumericUpDown)Get(panel,"clientReportMinutes")).Value!=10||((NumericUpDown)Get(panel,"dashboardReportMinutes")).Value!=5||!((CheckBox)Get(panel,"itemsEnabled")).Checked)throw new Exception("Stamp and item settings not loaded");
                ((CheckBox)Get(panel,"extensionBlocked")).Checked=false;
                if(((DateTimePicker)Get(panel,"extensionBlockedStart")).Enabled)throw new Exception("Disabled limits still editable");
                ((CheckBox)Get(panel,"extensionBlocked")).Checked=true;
                panel.PerformLayout();foreach(Control control in panel.Controls)if(control is TabControl){var section=((TabControl)control).TabPages[2].Controls[0];section.Dock=DockStyle.None;section.Width=560;section.PerformLayout();using(var image=new Bitmap(section.Width,section.Height)){section.DrawToBitmap(image,new Rectangle(Point.Empty,section.Size));image.Save(Path.Combine(screenshots,"admin-display-schedule.png"));}}
                panel.PerformLayout();foreach(Control control in panel.Controls)if(control is TabControl){var tabs=(TabControl)control;var section=tabs.TabPages[3].Controls[0];section.Dock=DockStyle.None;section.Width=560;section.PerformLayout();using(var image=new Bitmap(section.Width,section.Height)){section.DrawToBitmap(image,new Rectangle(Point.Empty,section.Size));image.Save(Path.Combine(screenshots,"admin-items.png"));}}
                var targets=(CheckedListBox)Get(panel,"giftTargets");var kinds=(CheckedListBox)Get(panel,"giftKinds");targets.SetItemChecked(0,true);kinds.SetItemChecked(0,true);kinds.SetItemChecked(3,true);((NumericUpDown)Get(panel,"giftQuantity")).Value=2;
                string outgoing=null;using(var done=new ManualResetEvent(false)){var outbox=new PanelOutbox(line=>{outgoing=line;done.Set();},error=>{throw error;});Set(panel,"outbox",outbox);typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(Get(panel,"distributeItems"),new object[]{EventArgs.Empty});if(!done.WaitOne(2000)||!outgoing.Contains("items/distribute")||!outgoing.Contains("\"quantity\":2")||!outgoing.Contains("guard")||!outgoing.Contains("skip"))throw new Exception("Item distribution did not serialize checked targets, kinds and quantity");outbox.Dispose();Set(panel,"outbox",null);}
                ((CheckBox)Get(panel,"itemsEnabled")).Checked=false;
                string settingsJson=null;using(var done=new ManualResetEvent(false)){var outbox=new PanelOutbox(line=>{settingsJson=line;done.Set();},error=>{throw error;});Set(panel,"outbox",outbox);typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(Get(panel,"saveRewards"),new object[]{EventArgs.Empty});if(!done.WaitOne(2000)||!settingsJson.Contains("items/settings")||!settingsJson.Contains("\"itemsEnabled\":false")||!settingsJson.Contains("\"standbyFailureDays\":3")||!settingsJson.Contains("\"clientReportMinutes\":10")||!settingsJson.Contains("\"dashboardReportMinutes\":5")||!settingsJson.Contains("\"extensionNoticeMinutes\":120")||!settingsJson.Contains("\"extensionBlockedStart\":1140")||!settingsJson.Contains("\"boostDraws\":3")||!settingsJson.Contains("\"rewardMode\":\"fixed\"")||!settingsJson.Contains("\"fixedKind\":\"guard\"")||!settingsJson.Contains("\"fixedQuantity\":2"))throw new Exception("Ticket limits did not serialize for saving");outbox.Dispose();Set(panel,"outbox",null);}
                if(((DataGridView)Get(panel,"itemInventory")).Rows.Count!=1)throw new Exception("Member inventory did not render");
            }finally{((NotifyIcon)Get(panel,"tray")).Dispose();((System.Windows.Forms.Timer)Get(panel,"saveTimeout")).Dispose();((System.Windows.Forms.Timer)Get(panel,"securityTimeout")).Dispose();panel.Dispose();}
            value=DashboardPreferences.Read();if(!value.fixedDetails||value.returnMinutes!=7)throw new Exception("Display preferences did not persist");
            new DashboardPreferences{fixedDetails=false,returnMinutes=5}.Save();value=DashboardPreferences.Read();if(value.fixedDetails||value.returnMinutes!=5)throw new Exception("Display preferences did not update");
            File.WriteAllText(Path.Combine(folder,"dashboard-display.json"),"{broken");if(DashboardPreferences.Read().returnMinutes!=1)throw new Exception("Corrupt preferences not handled");
        }finally{Environment.SetEnvironmentVariable("BATHJUN_DATA_DIR",previous);if(Directory.Exists(folder))Directory.Delete(folder,true);}
    }
    static void ReportTap(Form form,Type type,DashboardData data) {
        int reports=0;type.GetField("Report").SetValue(form,(Action<DashboardEntry>)(entry=>{if(entry.memberId!=1)throw new Exception("Wrong completion target");reports++;}));
        var update=type.GetMethod("UpdateData");var detailed=type.GetProperty("Detailed",BindingFlags.Instance|BindingFlags.NonPublic);Set(form,"detailedUntil",-1d);Set(form,"transition",0d);
        using(var bitmap=new Bitmap(form.ClientSize.Width,form.ClientSize.Height))form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,form.ClientSize));
        var areas=(List<KeyValuePair<RectangleF,DashboardEntry>>)Get(form,"reportAreas");if(areas.Count!=1)throw new Exception("Current bath has no completion button");var rect=areas[0].Key;
        var click=typeof(Control).GetMethod("OnMouseDown",BindingFlags.Instance|BindingFlags.NonPublic);var args=new object[]{new MouseEventArgs(MouseButtons.Left,1,(int)(rect.X+rect.Width/2),(int)(rect.Y+rect.Height/2),0)};click.Invoke(form,args);click.Invoke(form,args);
        if(reports!=1||(bool)detailed.GetValue(form,null))throw new Exception("Completion tap changed view or repeated submission");
        var copy=new JavaScriptSerializer().Deserialize<DashboardData>(new JavaScriptSerializer().Serialize(data));copy.now="2026-10-29T18:30:30+09:00";update.Invoke(form,new object[]{copy});
        if(type.GetMethod("PendingCompletion",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{DateTime.Parse(copy.now).ToUniversalTime()})==null)throw new Exception("Pending completion disappeared before deadline");
        copy.now="2026-10-29T18:31:01+09:00";update.Invoke(form,new object[]{copy});
        if(type.GetMethod("PendingCompletion",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{DateTime.Parse(copy.now).ToUniversalTime()})!=null)throw new Exception("Pending completion survived deadline");
        copy.reportMinutes=5;copy.now="2026-10-29T18:35:00+09:00";update.Invoke(form,new object[]{copy});if(type.GetMethod("PendingCompletion",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{DateTime.Parse(copy.now).ToUniversalTime()})==null)throw new Exception("Configured report deadline ignored");
        copy.now="2026-10-29T18:35:01+09:00";update.Invoke(form,new object[]{copy});if(type.GetMethod("PendingCompletion",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{DateTime.Parse(copy.now).ToUniversalTime()})!=null)throw new Exception("Configured report deadline not enforced");update.Invoke(form,new object[]{data});
    }
    static void Countdown(Form form,Type type,DashboardData data) {
        using(var bitmap=new Bitmap(800,300))using(var graphics=Graphics.FromImage(bitmap)){
            var fits=type.GetMethod("RemainingFits",BindingFlags.Instance|BindingFlags.NonPublic);
            var shortName=new object[]{graphics,new DashboardEntry{name="利用者A",endsAt=data.entries[0].endsAt},DateTime.UtcNow,500f,0f};
            var longName=new object[]{graphics,new DashboardEntry{name=new string('名',30),endsAt=data.entries[0].endsAt},DateTime.UtcNow,500f,0f};
            if(!(bool)fits.Invoke(form,shortName)||(bool)fits.Invoke(form,longName))throw new Exception("Countdown inline/fallback layout did not follow available width");
        }
        using(var bitmap=new Bitmap(600,150))using(var g=Graphics.FromImage(bitmap)){
            foreach(float width in new[]{200f,500f}){var rect=new RectangleF(0,0,width,80);var fitted=type.GetMethod("FittedSize",BindingFlags.Instance|BindingFlags.NonPublic);float size=(float)fitted.Invoke(form,new object[]{g,"次の予約はありません",32f,14f,rect,true});var font=(Font)type.GetMethod("TextFont",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{size,true});if(g.MeasureString("次の予約はありません",font).Width>width)throw new Exception("Empty booking label is truncated");}
        }
        var format=type.GetMethod("CountdownText",BindingFlags.Static|BindingFlags.NonPublic);
        var cases=new Dictionary<int,string>{{0,"0分"},{59,"59分"},{60,"1時間"},{90,"1時間30分"},{120,"2時間"},{135,"2時間15分"},{1440,"24時間"}};
        foreach(var item in cases)if((string)format.Invoke(null,new object[]{item.Key})!=item.Value)throw new Exception("Countdown duration format failed: "+item.Key);
        var emoji=type.GetMethod("EmojiImage",BindingFlags.Instance|BindingFlags.NonPublic);
        foreach(string value in new[]{"🐶","🐱","🌷","🌙","☀️","🛁"})if(emoji.Invoke(form,new object[]{value})==null)throw new Exception("Bundled emoji missing: "+value);
        var parts=type.GetMethod("RemainingParts",BindingFlags.Instance|BindingFlags.NonPublic);
        var reference=new DateTime(2026,10,29,8,0,0,DateTimeKind.Utc);
        string longRemaining=string.Join("",(string[])parts.Invoke(form,new object[]{new DashboardEntry{endsAt=reference.AddMinutes(135).ToString("o"),start=1000,duration=135},reference}));
        if(!longRemaining.Contains("2 時間 15 分"))throw new Exception("Remaining label did not format hours and minutes");
        var method=type.GetMethod("MinutesUntil",BindingFlags.Static|BindingFlags.NonPublic);
        DateTime now=new DateTime(2026,10,28,23,59,30,DateTimeKind.Utc);
        foreach(int seconds in new[]{-1,0,1,30,60,61,3600}) {
            int actual=(int)method.Invoke(null,new object[]{now.AddSeconds(seconds),now});
            if(actual!=(int)Math.Max(0,Math.Ceiling(seconds/60d)))throw new Exception("Countdown boundary failed");
        }
        var select=type.GetMethod("PeopleAt",BindingFlags.Instance|BindingFlags.NonPublic);
        var time=type.GetMethod("UpcomingTime",BindingFlags.Instance|BindingFlags.NonPublic);
        var start=DateTime.Parse(data.entries[0].startsAt).ToUniversalTime();
        var currentArgs=new object[]{start,null,null,null};select.Invoke(form,currentArgs);
        if(((DashboardEntry)currentArgs[1]).memberId!=1)throw new Exception("Exact start did not become current");
        var end=DateTime.Parse(data.entries[0].endsAt).ToUniversalTime();
        var idleArgs=new object[]{end,null,null,null};select.Invoke(form,idleArgs);
        if(idleArgs[1]!=null||((DashboardEntry)idleArgs[2]).memberId!=2||((DashboardEntry)idleArgs[3]).memberId!=5)throw new Exception("Idle state did not select the next two confirmed bookings");
        string label=(string)time.Invoke(form,new object[]{idleArgs[2],end});
        if(label!="30分後 | 19:00 〜 19:45")throw new Exception("Upcoming label lacks countdown and full time range: "+label);
    }
    static DateTime JapanTime(string value){return DateTime.SpecifyKind(DateTime.ParseExact(value,"yyyy-MM-dd HH:mm:ss",System.Globalization.CultureInfo.InvariantCulture),DateTimeKind.Utc).AddHours(-9);}
    static void DisplaySchedules(){
        var schedule=new DisplaySchedulePreferences();if(schedule.enabled||schedule.periods.Length!=2||schedule.periods[0].start!=480||schedule.periods[0].end!=900||schedule.periods[1].start!=120||schedule.periods[1].end!=240)throw new Exception("Invalid display schedule defaults");
        schedule.enabled=true;
        foreach(var test in new[]{new[]{"01:59:59","on"},new[]{"02:00:00","off"},new[]{"03:59:59","off"},new[]{"04:00:00","on"},new[]{"07:59:59","on"},new[]{"08:00:00","off"},new[]{"14:59:59","off"},new[]{"15:00:00","on"}})
            if(schedule.IsOffTime(JapanTime("2026-10-31 "+test[0]))!=(test[1]=="off"))throw new Exception("Display schedule boundary: "+test[0]);
        var overnight=new DisplaySchedulePreferences{enabled=true,periods=new[]{new DisplayOffPeriod{start=23*60,end=6*60},new DisplayOffPeriod{start=5*60,end=8*60}}};
        if(!overnight.IsOffTime(JapanTime("2026-10-31 23:00:00"))||!overnight.IsOffTime(JapanTime("2026-11-01 07:59:59"))||overnight.IsOffTime(JapanTime("2026-11-01 08:00:00")))throw new Exception("Overnight schedule or overlap failed");
        int off=0,on=0;bool visible=true;var events=new List<string>();
        var control=new DisplayScheduleController(value=>{visible=value;events.Add(value?"visible":"suppress");},()=>{if(visible)throw new Exception("Display lease not released before screen off");events.Add("off");off++;return true;},()=>{if(!visible)throw new Exception("Display lease not restored before screen on");events.Add("on");on++;return true;});
        var start=JapanTime("2026-10-31 08:00:00");
        control.Tick(schedule,start,true,60);control.Tick(schedule,start.AddSeconds(1),true,61);
        if(off!=1||!control.IsOffRequested||on!=0)throw new Exception("Screen off repeated during the same interval");
        control.Tick(schedule,start.AddSeconds(2),true,0);
        if(on!=1||control.IsOffRequested)throw new Exception("User activity did not wake display");
        control.Tick(schedule,start.AddSeconds(61),true,59);if(off!=1)throw new Exception("Temporary wake shorter than one minute");
        control.Tick(schedule,start.AddSeconds(62),true,60);if(off!=2)throw new Exception("Did not reapply scheduled off after idle");
        control.Tick(schedule,JapanTime("2026-10-31 15:00:00"),true,10000);if(on!=2||control.IsOffRequested)throw new Exception("Scheduled wake did not run at end");
        control.Tick(schedule,start,true,60);control.Tick(schedule,start.AddSeconds(1),false,60);
        if(control.IsOffRequested||on!=3)throw new Exception("Loss of eligibility did not wake owned screen");
        control.Tick(schedule,start,true,60);schedule.enabled=false;control.Tick(schedule,start.AddSeconds(1),true,60);
        if(control.IsOffRequested||on!=4)throw new Exception("Disabling schedule did not wake owned screen");
        schedule.enabled=true;int attempts=0;var retry=new DisplayScheduleController(value=>{},()=>{attempts++;return false;},()=>true);
        retry.Tick(schedule,start,true,60);retry.Tick(schedule,start.AddSeconds(29),true,90);if(attempts!=1||!retry.Failed)throw new Exception("Failed display command retries too quickly");
        retry.Tick(schedule,start.AddSeconds(30),true,90);if(attempts!=2)throw new Exception("Display command was not retried");
        retry.Tick(schedule,JapanTime("2026-10-31 15:00:00"),true,10000);if(retry.Failed)throw new Exception("Stale failure survived schedule transition");
        int wakeAttempts=0;var wakeRetry=new DisplayScheduleController(value=>{},()=>true,()=>++wakeAttempts>=2);
        wakeRetry.Tick(schedule,start,true,60);var end=JapanTime("2026-10-31 15:00:00");wakeRetry.Tick(schedule,end,true,10000);wakeRetry.Tick(schedule,end.AddSeconds(29),true,10000);wakeRetry.Tick(schedule,end.AddSeconds(30),true,10000);
        if(wakeAttempts!=2||wakeRetry.IsOffRequested||wakeRetry.Failed)throw new Exception("Wake failures were not retried");
        bool rejected=false;try{new DisplaySchedulePreferences{enabled=true,periods=new DisplayOffPeriod[0]}.Validate();}catch(ArgumentException){rejected=true;}if(!rejected)throw new Exception("Enabled empty schedule accepted");
        rejected=false;try{new DisplaySchedulePreferences{periods=new[]{new DisplayOffPeriod{start=120,end=120}}}.Validate();}catch(ArgumentException){rejected=true;}if(!rejected)throw new Exception("Equal schedule endpoints accepted");
        string previous=Environment.GetEnvironmentVariable("BATHJUN_DATA_DIR"),folder=Path.Combine(Path.GetTempPath(),"bathjun-display-schedule-"+Guid.NewGuid().ToString("N"));Environment.SetEnvironmentVariable("BATHJUN_DATA_DIR",folder);
        try{overnight.Save();var saved=DisplaySchedulePreferences.Read();if(!saved.enabled||saved.periods[0].start!=1380||saved.periods[0].end!=360)throw new Exception("Display schedule persistence failed");File.WriteAllText(Path.Combine(folder,"display-schedule.json"),"{broken");if(DisplaySchedulePreferences.Read().enabled)throw new Exception("Corrupt schedule did not fail open");}
        finally{Environment.SetEnvironmentVariable("BATHJUN_DATA_DIR",previous);if(Directory.Exists(folder))Directory.Delete(folder,true);}
    }

    static void ManualDisplays(){
        int off=0,on=0;bool visible=true;
        var control=new DisplayScheduleController(value=>visible=value,()=>{if(visible)throw new Exception("Manual off retained display lease");off++;return true;},()=>{if(!visible)throw new Exception("Manual wake did not restore display lease");on++;return true;});
        var preference=new DisplaySchedulePreferences();var now=JapanTime("2026-10-31 10:00:00");
        control.RequestManualOff(100);control.Tick(preference,now,true,0,100);control.Tick(preference,now.AddSeconds(1),true,1,100);
        if(off!=1||!control.ManualOffRequested||!control.IsOffRequested||visible)throw new Exception("Manual off did not persist with schedule disabled");
        control.Tick(preference,now.AddSeconds(2),true,0,101);if(on!=1||control.IsOffRequested||control.ManualOffRequested||!visible)throw new Exception("New input did not cancel manual off");
        preference.enabled=true;control.RequestManualOff(200);control.Tick(preference,now,true,0,200);control.Tick(preference,now.AddSeconds(1),true,1,200);
        if(off!=2||visible)throw new Exception("Scheduled display lease woke manual off");
        control.RefreshPowerState();control.Tick(preference,now.AddSeconds(2),true,2,200);if(off!=3)throw new Exception("Resume did not reissue off request");
        control.Tick(preference,JapanTime("2026-10-31 15:00:00"),true,10000,200);if(on!=2||control.IsOffRequested||control.ManualOffRequested)throw new Exception("Scheduled wake did not override manual off at the interval end");
        preference.enabled=false;control.RequestManualOff(300);control.Tick(preference,now,true,0,300);control.Tick(preference,now.AddSeconds(1),false,0,300);
        if(control.IsOffRequested||control.ManualOffRequested||on!=3)throw new Exception("Loss of server power safety did not restore the display");
        control.RequestManualOff(null);control.Tick(preference,now,true,0,null);control.CancelManualOff();control.Tick(preference,now.AddSeconds(1),true,0,null);if(control.IsOffRequested)throw new Exception("Explicit cancel did not wake screen when input tracking is unavailable");
    }
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        string installRoot=(string)typeof(Member).Assembly.GetType("ServerUpdate").GetProperty("InstallRoot",BindingFlags.Static|BindingFlags.NonPublic).GetValue(null,null);if(!Directory.Exists(installRoot))throw new Exception("Install root cannot resolve on .NET Framework");
        using(var host=new Form{ClientSize=new Size(320,200),ShowInTaskbar=false})using(var panel=new Panel{Dock=DockStyle.Fill,AutoScroll=true}){
            var content=new Panel{Width=280,Height=1500};var button=new Button{Text="test",Top=20};content.Controls.Add(button);panel.Controls.Add(content);host.Controls.Add(panel);var touchType=typeof(Member).Assembly.GetType("TouchScroll");using(var gestures=(IDisposable)Activator.CreateInstance(touchType,new object[]{host})){host.Show();Application.DoEvents();if(Environment.OSVersion.Platform==PlatformID.Win32NT&&!(bool)touchType.GetProperty("Configured",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(gestures,null))throw new Exception("Windows pan gestures were not configured");
            var scroll=typeof(Member).Assembly.GetType("TouchScroll").GetMethod("ScrollBy",BindingFlags.Static|BindingFlags.NonPublic);int clicks=0;button.Click+=delegate{clicks++;};
            if(!(bool)scroll.Invoke(null,new object[]{button,150})||-panel.AutoScrollPosition.Y!=150)throw new Exception("Drag did not scroll child controls");
            scroll.Invoke(null,new object[]{button,100000});if(-panel.AutoScrollPosition.Y<=150)throw new Exception("Long drag did not move scroll position");
            scroll.Invoke(null,new object[]{button,-100000});if(panel.AutoScrollPosition.Y!=0)throw new Exception("Drag exceeded upper bound");button.PerformClick();if(clicks!=1)throw new Exception("Scrolling disabled button taps");host.Close();}
        }
        DisplaySchedules();ManualDisplays();Preferences(args[1]);
        var type=typeof(DashboardData).Assembly.GetType("DashboardForm");
        var data=new JavaScriptSerializer().Deserialize<DashboardData>(File.ReadAllText(args[0]));
        foreach(var size in new[]{new Size(1280,720),new Size(1280,800),new Size(1440,960),new Size(1920,1080),new Size(1920,1280)}) {
            foreach(bool compact in new[]{false,true}) {
                // libgdiplus cannot measure PrivateFontCollection faces. On Linux,
                // use Fontconfig with the same bundled font files for rendering.
                // Windows uses the production private-font loader directly.
                var arguments=Environment.OSVersion.Platform==PlatformID.Win32NT
                    ? new object[]{(Action)(()=>{}),true}
                    : new object[]{(Action)(()=>{}),true,new FontFamily("Noto Sans JP")};
                var form=(Form)Activator.CreateInstance(type,arguments);
                if(form.Font.Name!="Noto Sans JP")throw new Exception("Dashboard did not load the shared typeface");
                using(var bold=new Font(form.Font.FontFamily,18,FontStyle.Bold))if(bold.Height<=0)throw new Exception("Shared bold font cannot be measured");
                try {
                    form.WindowState=FormWindowState.Normal;form.ClientSize=size;
                    type.GetMethod("UpdateData").Invoke(form,new object[]{data});Set(form,"held",true);Countdown(form,type,data);
                    var reader=type.GetField("presence",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);
                    Set(reader,"absent",true);Set(reader,"present",false);
                    var detailed=type.GetProperty("Detailed",BindingFlags.Instance|BindingFlags.NonPublic);
                    if((bool)detailed.GetValue(form,null))throw new Exception("Dashboard must initially show compact view");
                    // Touch works even when presence reports absent; no waiting or hardware required.
                    typeof(Control).GetMethod("OnMouseDown",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{new MouseEventArgs(MouseButtons.Left,1,20,200,0)});
                    if(!(bool)detailed.GetValue(form,null))throw new Exception("Touch did not open details");
                    double until=(double)type.GetField("detailedUntil",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);
                    var elapsed=(System.Diagnostics.Stopwatch)type.GetField("elapsed",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);
                    if(until-elapsed.Elapsed.TotalSeconds<59||until-elapsed.Elapsed.TotalSeconds>60)throw new Exception("Details timeout is not one minute");
                    Set(form,"detailedUntil",-1d);
                    if((bool)detailed.GetValue(form,null))throw new Exception("Expired detail view did not revert");
                    ReportTap(form,type,data);
                    Set(form,"transition",0d);Set(form,"transitionFrom",0d);Set(form,"transitionTarget",1d);
                    // Sample the transition's real easing path; reversing must not jump.
                    Set(form,"transitionStarted",elapsed.Elapsed.TotalSeconds-.21);Call(form,"Animate");
                    double mid=(double)Get(form,"transition");if(mid<.45||mid>.55)throw new Exception("Transition did not interpolate");
                    Call(form,"MoveTo",0d);if((double)Get(form,"transition")!=mid)throw new Exception("Reversing transition jumped");
                    Set(form,"transitionStarted",elapsed.Elapsed.TotalSeconds-.21);Call(form,"Animate");
                    if((double)Get(form,"transition")>=mid)throw new Exception("Return transition did not reverse");
                    type.GetMethod("ApplyPreferences").Invoke(form,new object[]{new DashboardPreferences{fixedDetails=true,returnMinutes=7}});
                    Set(form,"detailedUntil",-1d);if(!(bool)detailed.GetValue(form,null))throw new Exception("Fixed detailed view expired");
                    type.GetMethod("ApplyPreferences").Invoke(form,new object[]{new DashboardPreferences{fixedDetails=false,returnMinutes=5}});Call(form,"ShowDetails");
                    until=(double)Get(form,"detailedUntil");if(until-elapsed.Elapsed.TotalSeconds<299||until-elapsed.Elapsed.TotalSeconds>300)throw new Exception("Configured timeout ignored");
                    Set(form,"transition",compact?0d:1d);
                    if(!compact)Call(form,"ShowDetails");
                    using(var bitmap=new Bitmap(size.Width,size.Height)){form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,size));if(!compact){var people=(RectangleF)Get(form,"peopleArea");var schedule=(RectangleF)Get(form,"scheduleArea");if(schedule.Left<people.Right||schedule.Height<people.Height*1.4f)throw new Exception("Detailed schedule is not a tall column on the right");}bitmap.Save(Path.Combine(args[1],"dashboard-"+size.Width+"x"+size.Height+(compact?"-away":"")+".png"));}
                    if(compact&&size.Width==1280&&size.Height==720){
                        var empty=new JavaScriptSerializer().Deserialize<DashboardData>(File.ReadAllText(args[0]));empty.entries=new DashboardEntry[0];type.GetMethod("UpdateData").Invoke(form,new object[]{empty});
                        foreach(bool detailedEmpty in new[]{false,true}){Set(form,"transition",detailedEmpty?1d:0d);using(var image=new Bitmap(size.Width,size.Height)){form.DrawToBitmap(image,new Rectangle(Point.Empty,size));image.Save(Path.Combine(args[1],detailedEmpty?"dashboard-empty-detail.png":"dashboard-empty-compact.png"));}}Set(form,"transition",0d);
                        var idle=new JavaScriptSerializer().Deserialize<DashboardData>(File.ReadAllText(args[0]));idle.now="2026-10-29T18:45:00+09:00";
                        type.GetMethod("UpdateData").Invoke(form,new object[]{idle});
                        using(var bitmap=new Bitmap(size.Width,size.Height)){form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,size));bitmap.Save(Path.Combine(args[1],"dashboard-idle.png"));}
                        var hours=new JavaScriptSerializer().Deserialize<DashboardData>(File.ReadAllText(args[0]));hours.now="2026-10-29T16:15:00+09:00";hours.entries[0].start=960;hours.entries[0].duration=150;hours.entries[0].startsAt="2026-10-29T16:00:00+09:00";
                        type.GetMethod("UpdateData").Invoke(form,new object[]{hours});
                        using(var bitmap=new Bitmap(size.Width,size.Height)){form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,size));bitmap.Save(Path.Combine(args[1],"dashboard-hours.png"));}
                        type.GetMethod("UpdateData").Invoke(form,new object[]{data});
                    }
                    if(compact){Set(form,"transition",.5d);using(var bitmap=new Bitmap(size.Width,size.Height)){form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,size));bitmap.Save(Path.Combine(args[1],"dashboard-"+size.Width+"x"+size.Height+"-transition.png"));}}
                }finally{form.Dispose();}
            }
        }
        Console.WriteLine("Dashboard rendered at five landscape sizes from 16:9 through 3:2, with detailed and compact views.");
    }
}
