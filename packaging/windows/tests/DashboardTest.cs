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
                ((CheckBox)Get(panel,"dashboardFixed")).Checked=true;((NumericUpDown)Get(panel,"dashboardMinutes")).Value=7;
                if(((NumericUpDown)Get(panel,"dashboardMinutes")).Enabled)throw new Exception("Fixed mode did not disable timeout input");
                ClickSave(panel);
                var counts=new Dictionary<string,int>{{"skip",1},{"extend",1},{"boost",1},{"guard",2}};var weights=new Dictionary<string,int>{{"skip",1},{"extend",1},{"boost",1},{"guard",1}};
                Call(panel,"FillRewards",new RewardsAdmin{settings=new RewardSettings{extensionMinutes=30,boostDraws=3,rewardMode="fixed",fixedKind="guard",fixedQuantity=2,extensionBlocked=true,extensionBlockedStart=1140,extensionBlockedEnd=1380,extensionNoticeMinutes=120,skipNoticeMinutes=120,quantities=counts,weights=weights},members=new[]{new ItemMember{id=1,name="テスト利用者",wallet=new[]{new ItemCount{kind="guard",quantity=2}}}},history=new GiftRecord[0]});
                if(!((CheckBox)Get(panel,"extensionBlocked")).Checked||((NumericUpDown)Get(panel,"extensionNotice")).Value!=120||((DateTimePicker)Get(panel,"extensionBlockedStart")).Value.Hour!=19)throw new Exception("Ticket limits not loaded into controls");
                ((CheckBox)Get(panel,"extensionBlocked")).Checked=false;
                if(((DateTimePicker)Get(panel,"extensionBlockedStart")).Enabled)throw new Exception("Disabled limits still editable");
                ((CheckBox)Get(panel,"extensionBlocked")).Checked=true;
                panel.PerformLayout();foreach(Control control in panel.Controls)if(control is TabControl){var tabs=(TabControl)control;var section=tabs.TabPages[3].Controls[0];section.Dock=DockStyle.None;section.Width=560;section.PerformLayout();using(var image=new Bitmap(section.Width,section.Height)){section.DrawToBitmap(image,new Rectangle(Point.Empty,section.Size));image.Save(Path.Combine(screenshots,"admin-items.png"));}}
                var targets=(CheckedListBox)Get(panel,"giftTargets");var kinds=(CheckedListBox)Get(panel,"giftKinds");targets.SetItemChecked(0,true);kinds.SetItemChecked(0,true);kinds.SetItemChecked(3,true);((NumericUpDown)Get(panel,"giftQuantity")).Value=2;
                string outgoing=null;using(var done=new ManualResetEvent(false)){var outbox=new PanelOutbox(line=>{outgoing=line;done.Set();},error=>{throw error;});Set(panel,"outbox",outbox);typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(Get(panel,"distributeItems"),new object[]{EventArgs.Empty});if(!done.WaitOne(2000)||!outgoing.Contains("items/distribute")||!outgoing.Contains("\"quantity\":2")||!outgoing.Contains("guard")||!outgoing.Contains("skip"))throw new Exception("Item distribution did not serialize checked targets, kinds and quantity");outbox.Dispose();Set(panel,"outbox",null);}
                string settingsJson=null;using(var done=new ManualResetEvent(false)){var outbox=new PanelOutbox(line=>{settingsJson=line;done.Set();},error=>{throw error;});Set(panel,"outbox",outbox);typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(Get(panel,"saveRewards"),new object[]{EventArgs.Empty});if(!done.WaitOne(2000)||!settingsJson.Contains("items/settings")||!settingsJson.Contains("\"extensionNoticeMinutes\":120")||!settingsJson.Contains("\"extensionBlockedStart\":1140")||!settingsJson.Contains("\"boostDraws\":3")||!settingsJson.Contains("\"rewardMode\":\"fixed\"")||!settingsJson.Contains("\"fixedKind\":\"guard\"")||!settingsJson.Contains("\"fixedQuantity\":2"))throw new Exception("Ticket limits did not serialize for saving");outbox.Dispose();Set(panel,"outbox",null);}
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
        if(type.GetMethod("PendingCompletion",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{DateTime.Parse(copy.now).ToUniversalTime()})!=null)throw new Exception("Pending completion survived deadline");update.Invoke(form,new object[]{data});
    }
    static void Countdown(Form form,Type type,DashboardData data) {
        using(var bitmap=new Bitmap(800,300))using(var graphics=Graphics.FromImage(bitmap)){
            var fits=type.GetMethod("RemainingFits",BindingFlags.Instance|BindingFlags.NonPublic);
            var shortName=new object[]{graphics,new DashboardEntry{name="利用者A",endsAt=data.entries[0].endsAt},DateTime.UtcNow,500f,0f};
            var longName=new object[]{graphics,new DashboardEntry{name=new string('名',30),endsAt=data.entries[0].endsAt},DateTime.UtcNow,500f,0f};
            if(!(bool)fits.Invoke(form,shortName)||(bool)fits.Invoke(form,longName))throw new Exception("Countdown inline/fallback layout did not follow available width");
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
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        Preferences(args[1]);
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
                    using(var bitmap=new Bitmap(size.Width,size.Height)){form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,size));bitmap.Save(Path.Combine(args[1],"dashboard-"+size.Width+"x"+size.Height+(compact?"-away":"")+".png"));}
                    if(compact&&size.Width==1280&&size.Height==720){
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
