// Native .NET Framework UI. No browser, WebView or resident PowerShell process.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Runtime.Versioning;

[assembly: TargetFramework(".NETFramework,Version=v4.7.2", FrameworkDisplayName=".NET Framework 4.7.2")]

internal sealed class PowerLease : IDisposable {
    enum RequestType {Display=0,System=1,Execution=3}
    [StructLayout(LayoutKind.Sequential)] struct Reason { public uint Version; public uint Flags; public IntPtr SimpleReason; public uint ReservedA,ReservedB;public IntPtr ReservedC; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr PowerCreateRequest(ref Reason context);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool PowerSetRequest(IntPtr handle, RequestType type);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool PowerClearRequest(IntPtr handle, RequestType type);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint state);
    [StructLayout(LayoutKind.Sequential)] struct LastInput {public uint size,time;}
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetLastInputInfo(ref LastInput info);
    public static uint? LastInputTick(){var info=new LastInput{size=(uint)Marshal.SizeOf(typeof(LastInput))};return GetLastInputInfo(ref info)?info.time:(uint?)null;}
    public static uint IdleSeconds(){var info=new LastInput{size=(uint)Marshal.SizeOf(typeof(LastInput))};return GetLastInputInfo(ref info)?unchecked((uint)Environment.TickCount-info.time)/1000:0;}
    IntPtr handle=IntPtr.Zero; bool system,execution,display,thread;uint previousState;
    public bool Acquire(bool keepDisplay=false) {
        Dispose();
        IntPtr reason=Marshal.StringToHGlobalUni("ふろじゅんの予約サーバーと通知送信を、画面消灯中も継続しています。");
        try {var context=new Reason{Version=0,Flags=1,SimpleReason=reason,ReservedA=0,ReservedB=0,ReservedC=IntPtr.Zero};handle=PowerCreateRequest(ref context);}
        finally {Marshal.FreeHGlobal(reason);}
        if(handle==IntPtr.Zero || handle==new IntPtr(-1)){handle=IntPtr.Zero;return false;}
        system=PowerSetRequest(handle,RequestType.System); // PowerRequestSystemRequired
        execution=PowerSetRequest(handle,RequestType.Execution); // PowerRequestExecutionRequired (Modern Standby)
        previousState=SetThreadExecutionState(0x80000001);thread=previousState!=0;
        if(system&&execution&&thread&&(!keepDisplay||SetDisplay(true)))return true;
        Dispose();return false;
    }
    public bool SetDisplay(bool on){
        if(handle==IntPtr.Zero||!system||!execution||!thread)return false;
        if(display!=on){bool changed=on?PowerSetRequest(handle,RequestType.Display):PowerClearRequest(handle,RequestType.Display);if(!changed)return false;display=on;}
        return SetThreadExecutionState(0x80000001u|(on?0x00000002u:0u))!=0;
    }
    public bool PulseDisplay(){return SetThreadExecutionState(0x00000003)!=0;}
    public void Dispose() {if(handle!=IntPtr.Zero){if(display)PowerClearRequest(handle,RequestType.Display);if(execution)PowerClearRequest(handle,RequestType.Execution);if(system)PowerClearRequest(handle,RequestType.System);CloseHandle(handle);}if(thread)SetThreadExecutionState(previousState|0x80000000);handle=IntPtr.Zero;system=execution=display=thread=false;}

}
// A bounded, single writer queue keeps pipe writes and JSON work off the UI thread.
public sealed class PanelOutbox : IDisposable {
    readonly BlockingCollection<object> queue=new BlockingCollection<object>(32);
    readonly Thread sender;
    public PanelOutbox(Action<string> write,Action<Exception> failed) {
        sender=new Thread(delegate(){var serializer=new JavaScriptSerializer();try{foreach(var request in queue.GetConsumingEnumerable())write(serializer.Serialize(request));}catch(Exception error){failed(error);}});
        sender.IsBackground=true;sender.Start();
    }
    public bool Post(object request){try{return queue.TryAdd(request);}catch(InvalidOperationException){return false;}}
    public void Dispose(){queue.CompleteAdding();}
}
public sealed class Member {public int id;public string name;public bool active;}
public sealed class Schedule {public int bookingCutoff=420;public int lotteryStart,lotteryEnd,minDuration,maxDuration,step;public bool lotteryTimeRestricted;public string orderMode;public int[] fixedOrder;}
public sealed class Settings {public Member[] members;public Schedule current,upcoming;public string effectiveDay;public bool ignoreLowerPriorityWishes;}
public sealed class ServerState {public string phase,detail,url;public int pid;public bool serverPowerHeld;}
public sealed class SecurityMember {public int id;public string name;public bool passwordSet;}
public sealed class SecurityInfo {public bool familyConfigured;public SecurityMember[] members;}
public sealed class Verification {public bool matches,configured;}
public sealed class AccountChoice {public object Target;public string Title;public bool Configured;public override string ToString(){return Title+(Configured?"（設定済み）":"（未設定）");}}
public sealed class ItemCount {public string kind;public int quantity;}
public sealed class ItemMember {public int id,boostRemaining;public string name;public ItemCount[] wallet;public override string ToString(){return name;}}
public sealed class RewardSettings {public string rewardMode,fixedKind;public int fixedQuantity, extensionMinutes,boostDraws,extensionBlockedStart,extensionBlockedEnd,extensionNoticeMinutes,skipNoticeMinutes;public bool itemsEnabled=true,extensionBlocked,clientReportEnabled;public int standbyFailureDays=2,clientReportMinutes=3,dashboardReportMinutes=1;public Dictionary<string,int> quantities,weights;}
public sealed class GiftRecord {public string id,name,kind,createdAt,receivedAt;public int memberId,quantity;}
public sealed class RewardsAdmin {public RewardSettings settings;public ItemMember[] members;public GiftRecord[] history;}
public sealed class AnnouncementPage {public string id,title,text,imagePath;public bool hasImage;}
public sealed class AnnouncementEntry {public string id,label,state,published_at,created_at;public long? scheduled_at;public int readCount;public AnnouncementPage[] pages;public override string ToString(){return label+" · "+(state=="published"?"配信済み":state=="scheduled"?"予約済み":state=="archived"?"配信終了":"下書き")+" · 確認 "+readCount+"人";}}
public sealed class AnnouncementsAdmin {public AnnouncementEntry[] entries;}
public sealed class UpdateReadiness {public bool busy;}
public sealed class Reply {public string id;public bool ok,show;public string error,notice;public ServerState state;public Settings settings;public SecurityInfo security;public Verification verification;public DashboardData dashboard;public RewardsAdmin rewards;public AnnouncementsAdmin announcements;public UpdateReadiness readiness;}
internal sealed class PanelForm : Form {
    readonly ComboBox announcementList=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Width=550};
    readonly TextBox announcementLabel=new TextBox{Width=550};
    readonly DataGridView announcementPages=new DataGridView{Width=550,Height=250,AllowUserToAddRows=false,AllowUserToDeleteRows=false,RowHeadersVisible=false,AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill,SelectionMode=DataGridViewSelectionMode.CellSelect};
    readonly ComboBox announcementMode=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Width=220};
    readonly DateTimePicker announcementWhen=new DateTimePicker{Format=DateTimePickerFormat.Custom,CustomFormat="yyyy/MM/dd HH:mm",Width=220};
    readonly Button announcementSave=ActionButton("お知らせを保存・配信"),announcementArchive=ActionButton("配信を終了／予約を取り消す");
    readonly Label announcementFeedback=new Label{Width=550,Height=52};string announcementId,pendingAnnouncement;
    readonly CheckBox autoUpdateEnabled=new CheckBox{Text="自動で更新する（入浴中・開始直前を避ける）",AutoSize=true};
    readonly DateTimePicker autoUpdateTime=Clock();readonly Label updateFeedback=new Label{Width=550,Height=50};
    readonly System.Windows.Forms.Timer autoUpdateTimer=new System.Windows.Forms.Timer{Interval=60000};
    AutomaticUpdatePreferences autoUpdatePreferences=new AutomaticUpdatePreferences();DateTime nextAutoAttempt=DateTime.MinValue;
    TaskCompletionSource<bool> updateReadiness;string readinessRequest;
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    readonly string pipeName,token;
    TouchScroll touchScroll;CancellationTokenSource automaticUpdate;
    readonly Button releases=ActionButton("最新版を確認");
    WindowsDisplayService displayService;int displayPowerEpoch;
    readonly Label status=new Label(),detail=new Label(),powerState=new Label(),saveState=new Label();
    readonly TextBox link=new TextBox();readonly Button screen=new Button(),copy=new Button(),open=new Button(),save=new Button();
    readonly DataGridView members=new DataGridView();
    readonly TextBox newMemberName=new TextBox();
    readonly Button addMember=ActionButton("メンバーを追加");
    bool settingsLoaded;
    bool publicMode,updatePreparing;int serverPid;
    readonly CheckedListBox giftTargets=new CheckedListBox{Width=550,Height=130,CheckOnClick=true},giftKinds=new CheckedListBox{Width=550,Height=145,CheckOnClick=true};
    readonly NumericUpDown giftQuantity=new NumericUpDown{Minimum=1,Maximum=999,Value=1,Width=85},rewardExtension=new NumericUpDown{Minimum=5,Maximum=180,Increment=5,Value=30,Width=85},rewardDraws=new NumericUpDown{Minimum=1,Maximum=100,Value=3,Width=85};
    readonly ComboBox weeklyRewardMode=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Width=220},weeklyFixedKind=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Width=240};
    readonly NumericUpDown weeklyFixedQuantity=new NumericUpDown{Minimum=1,Maximum=99,Value=1,Width=85};
    readonly CheckBox clientReportEnabled=new CheckBox{Text="クライアントからの完了報告を許可する",AutoSize=true};
    readonly CheckBox itemsEnabled=new CheckBox{Text="アイテム機能を有効にする",Checked=true,AutoSize=true};
    readonly NumericUpDown standbyFailureDays=new NumericUpDown{Minimum=1,Maximum=30,Value=2,Width=85},clientReportMinutes=new NumericUpDown{Minimum=1,Maximum=180,Value=3,Width=85},dashboardReportMinutes=new NumericUpDown{Minimum=1,Maximum=180,Value=1,Width=85};
    readonly CheckBox extensionBlocked=new CheckBox{Text="延長チケットの使用禁止時間帯",AutoSize=true};
    readonly DateTimePicker extensionBlockedStart=Clock(),extensionBlockedEnd=Clock();
    readonly NumericUpDown extensionNotice=new NumericUpDown{Minimum=0,Maximum=1440,Value=120,Increment=15,Width=90},skipNotice=new NumericUpDown{Minimum=0,Maximum=1440,Value=120,Increment=15,Width=90};
    readonly Dictionary<string,NumericUpDown> rewardQuantities=new Dictionary<string,NumericUpDown>(),rewardWeights=new Dictionary<string,NumericUpDown>();
    readonly DataGridView itemInventory=new DataGridView(),giftHistory=new DataGridView();readonly Label itemFeedback=new Label();
    readonly Button distributeItems=ActionButton("配布"),saveRewards=ActionButton("特典設定を保存");
    static readonly string[] ItemKinds={"skip","extend","boost","guard","bathStamp","stampInk"};
    static string ItemTitle(string kind){return kind=="skip"?"順番抜かしチケット":kind=="extend"?"時間延長チケット":kind=="boost"?"抽選確率UPチケット":kind=="guard"?"順番抜かしガード":kind=="bathStamp"?"おふろスタンプ":"スタンプのインク";}
    DashboardForm dashboard;readonly CheckBox presenceEnabled=new CheckBox();
    readonly CheckBox automaticDisplay=new CheckBox{Text="時間帯で自動消灯・点灯する",AutoSize=true};
    readonly DataGridView displayPeriods=new DataGridView();
    readonly Label displayScheduleStatus=new Label{Width=550,Height=48};
    readonly System.Windows.Forms.Timer displayScheduleTimer=new System.Windows.Forms.Timer{Interval=1000};
    DisplaySchedulePreferences displaySchedule=DisplaySchedulePreferences.Read();
    readonly CheckBox dashboardFixed=new CheckBox();
    readonly NumericUpDown dashboardMinutes=new NumericUpDown{Minimum=1,Maximum=60,Value=1,Width=85};
    readonly DateTimePicker bookingCutoff=Clock(),drawStart=Clock(),drawEnd=Clock();
    readonly CheckBox drawRestricted=new CheckBox(),ignoreLowerPriorityWishes=new CheckBox();
    readonly NumericUpDown minimum=Number(),maximum=Number();readonly ComboBox step=new ComboBox(),orderMode=new ComboBox();
    readonly ComboBox passwordTarget=new ComboBox();
    readonly TextBox passwordInput=new TextBox(),passwordConfirm=new TextBox();
    readonly Label securityState=new Label();
    readonly Button verifyPassword=ActionButton("入力が現在のものか確認"),changePassword=ActionButton("新しいパスワードに変更"),resetData=ActionButton("全データをリセット");
    readonly System.Windows.Forms.Timer securityTimeout=new System.Windows.Forms.Timer{Interval=15000};
    string pendingSecurity;
    readonly NotifyIcon tray=new NotifyIcon();
    NamedPipeClientStream pipe;StreamWriter writer;Thread reader;bool connected,closing,canClose,powerHeld,serverPowerHeld;string currentPhase="starting";
    int sequence;PanelOutbox outbox;string pendingSave;readonly System.Windows.Forms.Timer saveTimeout=new System.Windows.Forms.Timer{Interval=15000};
    static DateTimePicker Clock(){return new DateTimePicker{Format=DateTimePickerFormat.Custom,CustomFormat="HH:mm",ShowUpDown=true,Width=100};}
    static NumericUpDown Number(){return new NumericUpDown{Minimum=5,Maximum=1440,Increment=5,Width=85};}
    static Label TextLabel(string text,int height){return new Label{Text=text,AutoSize=false,Width=550,Height=height,Padding=new Padding(0,5,0,0)};}
    static Button ActionButton(string text){return new Button{Text=text,Height=44,AutoSize=true,MinimumSize=new Size(120,44),Margin=new Padding(0,5,10,5)};}
    public PanelForm(string pipeName,string token,bool minimized) {
        SuspendLayout();
        AutoScaleDimensions=new SizeF(96F,96F);
        AutoScaleMode=AutoScaleMode.Dpi;
        this.pipeName=pipeName;this.token=token;
        saveTimeout.Tick+=delegate{saveTimeout.Stop();pendingSave=null;save.Enabled=connected;saveState.Text="保存の応答を確認できませんでした。「設定を再読込」で保存結果を確認してください。";};
        securityTimeout.Tick+=delegate{securityTimeout.Stop();pendingSecurity=null;SetSecurityBusy(false);securityState.Text="応答を確認できませんでした。再読込して状態を確認してください。";};
        Text="ふろじゅん — サーバー操作";Font=new Font("Yu Gothic UI",10);StartPosition=FormStartPosition.CenterScreen;ClientSize=new Size(620,590);MinimumSize=new Size(540,500);
        try{Icon=new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","app","public","icon.ico"));}catch{}
        var tabs=new TabControl{Dock=DockStyle.Fill};var home=new TabPage("稼働状況"){Padding=new Padding(18),AutoScroll=true};var config=new TabPage("設定"){Padding=new Padding(16),AutoScroll=true};tabs.TabPages.Add(home);tabs.TabPages.Add(config);Controls.Add(tabs);
        var layout=new FlowLayoutPanel{Dock=DockStyle.Top,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoSize=true};home.Controls.Add(layout);
        var title=TextLabel("ふろじゅん サーバー",48);title.Font=new Font(Font.FontFamily,18,FontStyle.Bold);title.Width=550;layout.Controls.Add(title);
        status.Text="起動しています…";status.Font=new Font(Font.FontFamily,13,FontStyle.Bold);status.Size=new Size(550,34);layout.Controls.Add(status);
        detail.Size=new Size(550,64);detail.ForeColor=Color.DimGray;layout.Controls.Add(detail);
        powerState.Size=new Size(550,60);layout.Controls.Add(powerState);
        screen.Text="画面だけ消す（サーバーは継続）";screen.Size=new Size(550,52);screen.Enabled=false;screen.Click+=delegate{TurnScreenOff();};layout.Controls.Add(screen);
        layout.Controls.Add(TextLabel("タッチ・マウス・キーボードで画面を戻せます。電源ボタンではなく、このボタンを使ってください。",62));
        layout.Controls.Add(TextLabel("家族用リンク",32));link.ReadOnly=true;link.Width=550;layout.Controls.Add(link);
        var linkButtons=new FlowLayoutPanel{AutoSize=true,Width=550};copy.Text="リンクをコピー";copy.Size=new Size(160,44);copy.Enabled=false;copy.Click+=delegate{try{Clipboard.SetText(link.Text);}catch{MessageBox.Show(this,"コピーできませんでした。リンク欄からコピーしてください。");}};open.Text="予約画面を開く";open.Size=new Size(160,44);open.Enabled=false;open.Click+=delegate{try{Process.Start(new ProcessStartInfo(link.Text){UseShellExecute=true});}catch{}};linkButtons.Controls.Add(copy);linkButtons.Controls.Add(open);layout.Controls.Add(linkButtons);
        var dashboardButton=ActionButton("ダッシュボードを開く");dashboardButton.Click+=delegate{OpenDashboard();};layout.Controls.Add(dashboardButton);
        presenceEnabled.Text="人感センサーで表示の明るさを調整（対応端末のみ）";presenceEnabled.AutoSize=true;
        presenceEnabled.Checked=ReadPresencePreference();presenceEnabled.CheckedChanged+=delegate{SavePresencePreference();};layout.Controls.Add(presenceEnabled);
        releases.Click+=delegate{if(automaticUpdate!=null){automaticUpdate.Cancel();return;}CheckForUpdates();};layout.Controls.Add(releases);
        BuildAutomaticUpdate(layout);
        var update=ActionButton("インストーラーを選んで更新");update.Click+=delegate{UpdateServer();};layout.Controls.Add(update);
        var stop=ActionButton("サーバーを停止して終了");stop.Click+=delegate{StopServer();};layout.Controls.Add(stop);
        layout.Controls.Add(TextLabel("×は通知領域にしまいます。スリープ防止はサーバー稼働中だけ有効で、終了すると解除します。AC電源につないで使ってください。",68));
        BuildSettings(config);var displayTab=new TabPage("ダッシュボード"){Padding=new Padding(16),AutoScroll=true};tabs.TabPages.Add(displayTab);BuildDashboardSettings(displayTab);var itemsTab=new TabPage("アイテム・特典"){Padding=new Padding(16),AutoScroll=true};tabs.TabPages.Add(itemsTab);BuildItems(itemsTab);var security=new TabPage("パスワード・リセット"){Padding=new Padding(16),AutoScroll=true};tabs.TabPages.Add(security);BuildSecurity(security);
        var announcementsTab=new TabPage("お知らせ"){Padding=new Padding(16),AutoScroll=true};tabs.TabPages.Add(announcementsTab);BuildAnnouncements(announcementsTab);
        var menu=new ContextMenuStrip();menu.Items.Add("操作画面を開く",null,delegate{ShowPanel();});menu.Items.Add("画面だけ消す",null,delegate{TurnScreenOff();});menu.Items.Add("サーバーを停止",null,delegate{StopServer();});tray.Icon=Icon;tray.Text="ふろじゅん サーバー";tray.ContextMenuStrip=menu;tray.DoubleClick+=delegate{ShowPanel();};tray.Visible=true;
        displayScheduleTimer.Tick+=delegate{TickDisplaySchedule();};
        autoUpdateTimer.Tick+=delegate{TryAutomaticUpdate();};
        Load+=delegate{displayService=new WindowsDisplayService();ShowPowerState();BeginRead();displayScheduleTimer.Start();autoUpdateTimer.Start();};
        Shown+=delegate{if(minimized){WindowState=FormWindowState.Minimized;Hide();}};
        FormClosing+=delegate(object sender,FormClosingEventArgs e){if(!canClose && e.CloseReason==CloseReason.UserClosing){e.Cancel=true;Hide();tray.ShowBalloonTip(2500,"ふろじゅん","サーバーは継続しています。通知領域のアイコンから操作画面に戻れます。",ToolTipIcon.Info);}};
        FormClosed+=delegate{closing=true;autoUpdateTimer.Stop();autoUpdateTimer.Dispose();if(updateReadiness!=null)updateReadiness.TrySetResult(false);if(automaticUpdate!=null)automaticUpdate.Cancel();if(touchScroll!=null)touchScroll.Dispose();displayScheduleTimer.Stop();if(displayService!=null)displayService.Dispose();displayScheduleTimer.Dispose();if(dashboard!=null)dashboard.Close();saveTimeout.Dispose();securityTimeout.Dispose();if(outbox!=null)outbox.Dispose();tray.Visible=false;tray.Dispose();try{pipe.Dispose();}catch{}};
        ResumeLayout(true);touchScroll=new TouchScroll(this);
    }
    void BuildAnnouncements(TabPage page){
        var box=new FlowLayoutPanel{FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoSize=true,Dock=DockStyle.Top};page.Controls.Add(box);
        box.Controls.Add(TextLabel("お知らせは、ログイン後の画面内に表示します。プッシュ通知は送りません。配信後は編集せず、新しく作成してください。画像は1ページ1枚、PNG/JPEG・2MBまでです。",76));
        box.Controls.Add(announcementList);announcementList.SelectedIndexChanged+=delegate{LoadAnnouncement(announcementList.SelectedItem as AnnouncementEntry);};
        var create=ActionButton("新しいお知らせ");create.Click+=delegate{announcementList.SelectedIndex=-1;LoadAnnouncement(null);};box.Controls.Add(create);
        box.Controls.Add(new Label{Text="管理用の名前",AutoSize=true});box.Controls.Add(announcementLabel);
        announcementPages.Columns.Add("Title","タイトル");announcementPages.Columns.Add("Text","本文");announcementPages.Columns.Add("Image","画像ファイル");announcementPages.Columns.Add(new DataGridViewCheckBoxColumn{Name="Remove",HeaderText="画像削除",FillWeight=45});announcementPages.Columns["Text"].FillWeight=180;announcementPages.DefaultCellStyle.WrapMode=DataGridViewTriState.True;announcementPages.RowTemplate.Height=72;box.Controls.Add(announcementPages);
        var actions=new FlowLayoutPanel{Width=550,AutoSize=true};var add=new Button{Text="ページ追加",Width=125,Height=38};var remove=new Button{Text="ページ削除",Width=125,Height=38};var image=new Button{Text="画像を選ぶ",Width=125,Height=38};
        add.Click+=delegate{if(announcementPages.Rows.Count<10)announcementPages.Rows.Add("","","",false);};remove.Click+=delegate{if(announcementPages.CurrentCell!=null&&announcementPages.Rows.Count>1)announcementPages.Rows.RemoveAt(announcementPages.CurrentCell.RowIndex);};
        image.Click+=delegate{if(announcementPages.CurrentCell==null)return;using(var picker=new OpenFileDialog{Filter="画像|*.png;*.jpg;*.jpeg"})if(picker.ShowDialog(this)==DialogResult.OK){var row=announcementPages.Rows[announcementPages.CurrentCell.RowIndex];row.Cells["Image"].Value=picker.FileName;row.Cells["Remove"].Value=false;}};var edit=new Button{Text="本文を編集",Width=125,Height=38};edit.Click+=delegate{EditAnnouncementPage();};actions.Controls.AddRange(new Control[]{add,remove,image,edit});box.Controls.Add(actions);
        announcementMode.Items.AddRange(new object[]{"下書き","今すぐ配信","日時を指定して配信"});announcementMode.SelectedIndex=0;announcementMode.SelectedIndexChanged+=delegate{announcementWhen.Enabled=announcementMode.SelectedIndex==2;};box.Controls.Add(announcementMode);announcementWhen.Value=DateTime.Now.AddHours(1);box.Controls.Add(announcementWhen);
        announcementSave.Click+=delegate{if(pendingAnnouncement!=null)return;announcementPages.EndEdit();var pages=new List<object>();foreach(DataGridViewRow row in announcementPages.Rows){string path=Convert.ToString(row.Cells["Image"].Value);pages.Add(new{id=row.Tag as string,title=Convert.ToString(row.Cells["Title"].Value),text=Convert.ToString(row.Cells["Text"].Value),imagePath=Path.IsPathRooted(path)?path:null,removeImage=Convert.ToBoolean(row.Cells["Remove"].Value)});}pendingAnnouncement=Send("announcements/save",new{id=announcementId,label=announcementLabel.Text,state=announcementMode.SelectedIndex==2?"scheduled":announcementMode.SelectedIndex==1?"published":"draft",scheduledAt=new DateTimeOffset(announcementWhen.Value).ToUnixTimeMilliseconds(),pages=pages});announcementSave.Enabled=pendingAnnouncement==null;announcementFeedback.Text=pendingAnnouncement==null?"サーバーに接続してください。":"保存しています…";};box.Controls.Add(announcementSave);
        announcementArchive.Click+=delegate{if(announcementId!=null&&pendingAnnouncement==null)pendingAnnouncement=Send("announcements/archive",new{id=announcementId});};box.Controls.Add(announcementArchive);box.Controls.Add(announcementFeedback);LoadAnnouncement(null);
    }
    void EditAnnouncementPage(){
        if(announcementPages.CurrentCell==null)return;announcementPages.EndEdit();var row=announcementPages.Rows[announcementPages.CurrentCell.RowIndex];
        using(var editor=new Form{Text="お知らせのページ",ClientSize=new Size(540,530),StartPosition=FormStartPosition.CenterParent,Font=Font,MinimizeBox=false,MaximizeBox=false}){
            editor.AutoScaleDimensions=new SizeF(96,96);editor.AutoScaleMode=AutoScaleMode.Dpi;
            var titleLabel=new Label{Text="タイトル",Location=new Point(18,16),AutoSize=true};var title=new TextBox{Location=new Point(18,42),Width=504,MaxLength=100,Text=Convert.ToString(row.Cells["Title"].Value),Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right};
            var bodyLabel=new Label{Text="本文",Location=new Point(18,82),AutoSize=true};var body=new TextBox{Location=new Point(18,108),Size=new Size(504,340),Multiline=true,AcceptsReturn=true,ScrollBars=ScrollBars.Vertical,MaxLength=3000,Text=Convert.ToString(row.Cells["Text"].Value),Anchor=AnchorStyles.Top|AnchorStyles.Bottom|AnchorStyles.Left|AnchorStyles.Right};
            var apply=new Button{Text="ページに反映",DialogResult=DialogResult.OK,Location=new Point(18,470),Size=new Size(240,42),Anchor=AnchorStyles.Bottom|AnchorStyles.Left};var cancel=new Button{Text="キャンセル",DialogResult=DialogResult.Cancel,Location=new Point(280,470),Size=new Size(240,42),Anchor=AnchorStyles.Bottom|AnchorStyles.Right};editor.CancelButton=cancel;editor.Controls.AddRange(new Control[]{titleLabel,title,bodyLabel,body,apply,cancel});
            if(editor.ShowDialog(this)==DialogResult.OK){row.Cells["Title"].Value=title.Text;row.Cells["Text"].Value=body.Text;}
        }
    }
    void LoadAnnouncement(AnnouncementEntry entry){
        announcementId=entry==null?null:entry.id;announcementLabel.Text=entry==null?"":entry.label;announcementPages.Rows.Clear();foreach(var item in entry==null?new[]{new AnnouncementPage{title="",text=""}}:entry.pages){int row=announcementPages.Rows.Add(item.title,item.text,item.hasImage?"（登録済み）":"",false);announcementPages.Rows[row].Tag=item.id;}
        announcementMode.SelectedIndex=entry==null||entry.state=="draft"?0:entry.state=="scheduled"?2:1;if(entry!=null&&entry.scheduled_at.HasValue)announcementWhen.Value=DateTimeOffset.FromUnixTimeMilliseconds(entry.scheduled_at.Value).LocalDateTime;
        announcementSave.Enabled=entry==null||entry.state=="draft"||entry.state=="scheduled";announcementArchive.Enabled=entry!=null&&entry.state!="archived";
    }
    void FillAnnouncements(AnnouncementsAdmin data){announcementList.Items.Clear();foreach(var entry in data.entries??new AnnouncementEntry[0])announcementList.Items.Add(entry);LoadAnnouncement(null);announcementFeedback.Text="保存済みのお知らせと配信履歴を表示しています。";}
    string AutomaticUpdatePath(){return Path.Combine(Path.GetDirectoryName(PresencePreferencePath()),"automatic-update.json");}
    void BuildAutomaticUpdate(FlowLayoutPanel box){
        try{if(File.Exists(AutomaticUpdatePath()))autoUpdatePreferences=json.Deserialize<AutomaticUpdatePreferences>(File.ReadAllText(AutomaticUpdatePath()));}catch{autoUpdatePreferences=new AutomaticUpdatePreferences{enabled=false};}
        if(autoUpdatePreferences==null||autoUpdatePreferences.minute<0||autoUpdatePreferences.minute>=1440)autoUpdatePreferences=new AutomaticUpdatePreferences{enabled=false};
        autoUpdateEnabled.Checked=autoUpdatePreferences.enabled;autoUpdateTime.Value=ToClock(autoUpdatePreferences.minute);box.Controls.Add(autoUpdateEnabled);var row=new FlowLayoutPanel{Width=550,AutoSize=true};row.Controls.Add(new Label{Text="毎日確認する時刻（日本時間）",AutoSize=true});row.Controls.Add(autoUpdateTime);box.Controls.Add(row);
        var save=ActionButton("自動更新の設定を保存");save.Click+=delegate{autoUpdatePreferences.enabled=autoUpdateEnabled.Checked;autoUpdatePreferences.minute=Minutes(autoUpdateTime);autoUpdatePreferences.checkedDay=null;SaveAutomaticUpdate();updateFeedback.Text="設定を保存しました。入浴中や開始10分前からは更新を見送ります。";};box.Controls.Add(save);box.Controls.Add(updateFeedback);
    }
    void SaveAutomaticUpdate(){try{Directory.CreateDirectory(Path.GetDirectoryName(AutomaticUpdatePath()));File.WriteAllText(AutomaticUpdatePath(),json.Serialize(autoUpdatePreferences));}catch{updateFeedback.Text="自動更新の設定を保存できませんでした。";}}
    async Task<bool> CanAutomaticallyUpdate(){
        if(pendingSave!=null||pendingSecurity!=null||pendingAnnouncement!=null)return false;
        var wait=new TaskCompletionSource<bool>();updateReadiness=wait;readinessRequest=Send("update/status",null);if(readinessRequest==null)return false;
        var completed=await Task.WhenAny(wait.Task,Task.Delay(15000));if(updateReadiness==wait)updateReadiness=null;
        return completed==wait.Task&&await wait.Task;
    }
    void TryAutomaticUpdate(){if(!closing&&connected&&currentPhase=="ready"&&!updatePreparing&&DateTime.UtcNow>=nextAutoAttempt&&autoUpdatePreferences.Due(DateTime.UtcNow.AddHours(9))){nextAutoAttempt=DateTime.UtcNow.AddMinutes(15);CheckForUpdates(true);}}
    void BuildItems(TabPage page) {
        var box=new FlowLayoutPanel{Dock=DockStyle.Top,AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false};page.Controls.Add(box);
        box.Controls.Add(itemsEnabled);
        var standbyRow=new FlowLayoutPanel{Width=550,AutoSize=true,Padding=new Padding(0,8,0,8)};standbyRow.Controls.Add(new Label{Text="連続して入らないと失敗になる日数",Width=330,Margin=new Padding(0,6,8,0)});standbyRow.Controls.Add(standbyFailureDays);box.Controls.Add(standbyRow);
        box.Controls.Add(clientReportEnabled);clientReportMinutes.Enabled=false;clientReportEnabled.CheckedChanged+=delegate{clientReportMinutes.Enabled=clientReportEnabled.Checked;};
        foreach(bool client in new[]{true,false}){var row=new FlowLayoutPanel{Width=550,AutoSize=true,Padding=new Padding(0,4,0,4)};row.Controls.Add(new Label{Text=client?"完了報告：クライアント（終了後の分数）":"完了報告：ダッシュボード（終了後の分数）",Width=330,Margin=new Padding(0,6,8,0)});row.Controls.Add(client?clientReportMinutes:dashboardReportMinutes);box.Controls.Add(row);}
        box.Controls.Add(TextLabel("設定の変更は下の「特典設定を保存」で保存します。",40));
        box.Controls.Add(TextLabel("メンバーの持ち物",36));itemInventory.Size=new Size(550,180);itemInventory.ReadOnly=true;itemInventory.AllowUserToAddRows=itemInventory.AllowUserToDeleteRows=false;itemInventory.AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill;itemInventory.RowHeadersVisible=false;
        foreach(string key in new[]{"メンバー","順番抜かし","時間延長","確率UP","ガード","スタンプ","インク","UP残回数"})itemInventory.Columns.Add(key,key);box.Controls.Add(itemInventory);
        box.Controls.Add(TextLabel("対象",32));box.Controls.Add(giftTargets);box.Controls.Add(TextLabel("内容",32));foreach(string kind in ItemKinds)giftKinds.Items.Add(ItemTitle(kind));box.Controls.Add(giftKinds);
        var countRow=new FlowLayoutPanel{Width=550,AutoSize=true};countRow.Controls.Add(new Label{Text="個数（各アイテム・各メンバーへ）",AutoSize=true});countRow.Controls.Add(giftQuantity);box.Controls.Add(countRow);box.Controls.Add(distributeItems);
        distributeItems.Click+=delegate{
            var ids=new List<int>();foreach(ItemMember person in giftTargets.CheckedItems)ids.Add(person.id);var kinds=new List<string>();for(int i=0;i<ItemKinds.Length;i++)if(giftKinds.GetItemChecked(i))kinds.Add(ItemKinds[i]);
            if(ids.Count==0||kinds.Count==0){itemFeedback.Text="対象と内容を選んでください。";return;}
            distributeItems.Enabled=false;if(Send("items/distribute",new{recipients=ids.ToArray(),kinds=kinds.ToArray(),quantity=(int)giftQuantity.Value,requestId=Guid.NewGuid().ToString("N")})==null)distributeItems.Enabled=true;
        };
        itemFeedback.Size=new Size(550,50);box.Controls.Add(itemFeedback);
        box.Controls.Add(TextLabel("配布履歴（全メンバー）",36));giftHistory.Size=new Size(550,180);giftHistory.ReadOnly=true;giftHistory.AllowUserToAddRows=giftHistory.AllowUserToDeleteRows=false;giftHistory.RowHeadersVisible=false;giftHistory.AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill;
        foreach(string key in new[]{"配布日時","対象","内容","個数","受取状態"})giftHistory.Columns.Add(key,key);box.Controls.Add(giftHistory);
        box.Controls.Add(TextLabel("週間特典の設定",36));
        weeklyRewardMode.Items.AddRange(new object[]{"ルーレットで決める","固定で渡す","固定＋ルーレット"});weeklyRewardMode.SelectedIndex=0;box.Controls.Add(weeklyRewardMode);
        var fixedRow=new FlowLayoutPanel{Width=550,AutoSize=true,Padding=new Padding(0,4,0,8)};foreach(string kind in ItemKinds)weeklyFixedKind.Items.Add(ItemTitle(kind));weeklyFixedKind.SelectedIndex=1;fixedRow.Controls.Add(weeklyFixedKind);fixedRow.Controls.Add(new Label{Text="個数",AutoSize=true,Margin=new Padding(8,6,6,0)});fixedRow.Controls.Add(weeklyFixedQuantity);box.Controls.Add(fixedRow);
        weeklyRewardMode.SelectedIndexChanged+=delegate{bool fixedMode=weeklyRewardMode.SelectedIndex==1;weeklyFixedKind.Enabled=weeklyFixedQuantity.Enabled=weeklyRewardMode.SelectedIndex!=0;foreach(string kind in ItemKinds){rewardQuantities[kind].Enabled=rewardWeights[kind].Enabled=!fixedMode;}};weeklyFixedKind.Enabled=weeklyFixedQuantity.Enabled=false;
        box.Controls.Add(TextLabel("「固定＋ルーレット」は、固定報酬に加えて抽選した報酬も渡します。変更は以後の達成から反映されます。",62));foreach(bool extend in new[]{true,false}){var duration=new FlowLayoutPanel{Width=550,AutoSize=true,Padding=new Padding(0,4,0,4)};duration.Controls.Add(new Label{Text=extend?"時間延長（分）":"確率UP（抽選回数）",Width=260,Margin=new Padding(0,6,8,0)});duration.Controls.Add(extend?rewardExtension:rewardDraws);box.Controls.Add(duration);}
        foreach(string kind in ItemKinds){var row=new FlowLayoutPanel{Width=550,AutoSize=true};row.Controls.Add(new Label{Text=ItemTitle(kind),Width=210,Height=36,Margin=new Padding(0,6,8,0)});var quantity=new NumericUpDown{Minimum=1,Maximum=99,Value=kind=="guard"?2:1,Width=65};var weight=new NumericUpDown{Minimum=0,Maximum=100,Value=kind=="bathStamp"?0:1,Width=65};rewardQuantities.Add(kind,quantity);rewardWeights.Add(kind,weight);row.Controls.Add(new Label{Text="個数",AutoSize=true,Margin=new Padding(6,6,6,0)});row.Controls.Add(quantity);row.Controls.Add(new Label{Text="出現比率",AutoSize=true,Margin=new Padding(6,6,6,0)});row.Controls.Add(weight);box.Controls.Add(row);}
        box.Controls.Add(TextLabel("チケットの使用制限",36));
        box.Controls.Add(extensionBlocked);
        var hours=new FlowLayoutPanel{Width=550,AutoSize=true,Padding=new Padding(0,4,0,8)};hours.Controls.Add(extensionBlockedStart);hours.Controls.Add(new Label{Text="〜",AutoSize=true,Margin=new Padding(8,7,8,0)});hours.Controls.Add(extensionBlockedEnd);box.Controls.Add(hours);
        extensionBlocked.CheckedChanged+=delegate{extensionBlockedStart.Enabled=extensionBlockedEnd.Enabled=extensionBlocked.Checked;};
        foreach(bool extend in new[]{true,false}){var row=new FlowLayoutPanel{Width=550,AutoSize=true,Padding=new Padding(0,4,0,4)};row.Controls.Add(new Label{Text=extend?"延長：開始までの残り時間（分）":"順番抜かし：開始までの残り時間（分）",Width=330,Margin=new Padding(0,6,8,0)});row.Controls.Add(extend?extensionNotice:skipNotice);box.Controls.Add(row);}
        box.Controls.Add(TextLabel("指定した分数以下の予約は禁止します。0分で直前の使用制限を解除します。禁止時間帯と重なる予約も、延長チケットを使用できません。",64));
        box.Controls.Add(saveRewards);saveRewards.Click+=delegate{var quantities=new Dictionary<string,int>();var weights=new Dictionary<string,int>();foreach(string kind in ItemKinds){quantities[kind]=(int)rewardQuantities[kind].Value;weights[kind]=(int)rewardWeights[kind].Value;}saveRewards.Enabled=false;if(Send("items/settings",new{itemsEnabled=itemsEnabled.Checked,standbyFailureDays=(int)standbyFailureDays.Value,clientReportEnabled=clientReportEnabled.Checked,clientReportMinutes=(int)clientReportMinutes.Value,dashboardReportMinutes=(int)dashboardReportMinutes.Value,rewardMode=weeklyRewardMode.SelectedIndex==2?"both":weeklyRewardMode.SelectedIndex==1?"fixed":"roulette",fixedKind=ItemKinds[Math.Max(0,weeklyFixedKind.SelectedIndex)],fixedQuantity=(int)weeklyFixedQuantity.Value,extensionMinutes=(int)rewardExtension.Value,boostDraws=(int)rewardDraws.Value,extensionBlocked=extensionBlocked.Checked,extensionBlockedStart=Minutes(extensionBlockedStart),extensionBlockedEnd=Minutes(extensionBlockedEnd),extensionNoticeMinutes=(int)extensionNotice.Value,skipNoticeMinutes=(int)skipNotice.Value,quantities=quantities,weights=weights})==null)saveRewards.Enabled=true;};
        var reload=ActionButton("持ち物・配布履歴を再読込");reload.Click+=delegate{Send("items/get",null);};box.Controls.Add(reload);
    }
    void FillRewards(RewardsAdmin value) {
        distributeItems.Enabled=saveRewards.Enabled=true;itemFeedback.Text="持ち物・配布履歴を更新しました。";
        var checkedIds=new HashSet<int>();foreach(ItemMember member in giftTargets.CheckedItems)checkedIds.Add(member.id);giftTargets.Items.Clear();itemInventory.Rows.Clear();
        foreach(var person in value.members){giftTargets.Items.Add(person,checkedIds.Contains(person.id));var counts=new int[ItemKinds.Length];foreach(var item in person.wallet){int index=Array.IndexOf(ItemKinds,item.kind);if(index>=0)counts[index]=item.quantity;}itemInventory.Rows.Add(person.name,counts[0],counts[1],counts[2],counts[3],counts[4],counts[5],person.boostRemaining);}
        giftHistory.Rows.Clear();foreach(var gift in value.history)giftHistory.Rows.Add(DateTime.Parse(gift.createdAt).ToUniversalTime().AddHours(9).ToString("MM/dd HH:mm"),gift.name,ItemTitle(gift.kind),gift.quantity,gift.receivedAt==null?"未受取":"受取済み");
        itemsEnabled.Checked=value.settings.itemsEnabled;clientReportEnabled.Checked=value.settings.clientReportEnabled;standbyFailureDays.Value=value.settings.standbyFailureDays;clientReportMinutes.Value=value.settings.clientReportMinutes;dashboardReportMinutes.Value=value.settings.dashboardReportMinutes;
        distributeItems.Enabled=value.settings.itemsEnabled;
        extensionBlocked.Checked=value.settings.extensionBlocked;extensionBlockedStart.Value=ToClock(value.settings.extensionBlockedStart);extensionBlockedEnd.Value=ToClock(value.settings.extensionBlockedEnd);extensionBlockedStart.Enabled=extensionBlockedEnd.Enabled=extensionBlocked.Checked;extensionNotice.Value=value.settings.extensionNoticeMinutes;skipNotice.Value=value.settings.skipNoticeMinutes;
        weeklyRewardMode.SelectedIndex=value.settings.rewardMode=="both"?2:value.settings.rewardMode=="fixed"?1:0;weeklyFixedKind.SelectedIndex=Math.Max(0,Array.IndexOf(ItemKinds,value.settings.fixedKind));weeklyFixedQuantity.Value=Math.Max(1,value.settings.fixedQuantity);
        rewardExtension.Value=value.settings.extensionMinutes;rewardDraws.Value=value.settings.boostDraws;foreach(string kind in ItemKinds){rewardQuantities[kind].Value=value.settings.quantities[kind];rewardWeights[kind].Value=value.settings.weights[kind];}
    }
    void BuildDashboardSettings(TabPage page) {
        var box=new FlowLayoutPanel{Dock=DockStyle.Top,AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false};page.Controls.Add(box);
        box.Controls.Add(TextLabel("ダッシュボードの表示",38));
        dashboardFixed.Text="詳細表示に固定する";dashboardFixed.AutoSize=true;box.Controls.Add(dashboardFixed);
        var row=new FlowLayoutPanel{Width=550,AutoSize=true};row.Controls.Add(new Label{Text="最後の操作から簡易表示に戻るまで",AutoSize=true,Margin=new Padding(0,7,10,0)});row.Controls.Add(dashboardMinutes);row.Controls.Add(new Label{Text="分",AutoSize=true,Margin=new Padding(8,7,0,0)});box.Controls.Add(row);
        dashboardFixed.CheckedChanged+=delegate{dashboardMinutes.Enabled=!dashboardFixed.Checked;};
        var value=DashboardPreferences.Read();dashboardMinutes.Value=value.returnMinutes;dashboardFixed.Checked=value.fixedDetails;
        box.Controls.Add(TextLabel("簡易表示をタッチすると詳細表示に切り替わります。設定はこのサーバーPCに保存され、次回起動後も引き継ぎます。",70));
        box.Controls.Add(TextLabel("自動消灯・点灯（日本時間）",38));automaticDisplay.Checked=displaySchedule.enabled;box.Controls.Add(automaticDisplay);
        displayPeriods.Size=new Size(550,170);displayPeriods.AllowUserToAddRows=false;displayPeriods.AllowUserToDeleteRows=true;displayPeriods.RowHeadersVisible=false;displayPeriods.AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill;
        displayPeriods.Columns.Add(new DataGridViewTextBoxColumn{Name="Start",HeaderText="消灯する時刻",MaxInputLength=5});displayPeriods.Columns.Add(new DataGridViewTextBoxColumn{Name="End",HeaderText="点灯する時刻",MaxInputLength=5});
        foreach(var period in displaySchedule.periods)displayPeriods.Rows.Add(ToClock(period.start).ToString("HH:mm"),ToClock(period.end).ToString("HH:mm"));box.Controls.Add(displayPeriods);
        var periodButtons=new FlowLayoutPanel{Width=550,AutoSize=true};var addPeriod=ActionButton("時間帯を追加");var removePeriod=ActionButton("選択した時間帯を削除");periodButtons.Controls.Add(addPeriod);periodButtons.Controls.Add(removePeriod);box.Controls.Add(periodButtons);
        addPeriod.Click+=delegate{if(displayPeriods.Rows.Count>=8)return;int index=displayPeriods.Rows.Add("08:00","15:00");displayPeriods.CurrentCell=displayPeriods.Rows[index].Cells[0];displayPeriods.BeginEdit(true);};
        removePeriod.Click+=delegate{if(displayPeriods.CurrentRow!=null)displayPeriods.Rows.Remove(displayPeriods.CurrentRow);};
        box.Controls.Add(TextLabel("HH:mm形式で入力。日をまたぐ時間帯も指定できます。終了時刻に自動点灯します。AC電源で使ってください。操作後は1分間点灯します。",70));box.Controls.Add(displayScheduleStatus);
        var openPowerLog=ActionButton("画面制御の診断ログを開く");box.Controls.Add(openPowerLog);
        openPowerLog.Click+=delegate{if(displayService==null||!File.Exists(displayService.LogPath)){MessageBox.Show(this,"診断ログはまだありません。");return;}try{Process.Start(new ProcessStartInfo(displayService.LogPath){UseShellExecute=true});}catch{MessageBox.Show(this,"診断ログを開けませんでした。保存先："+displayService.LogPath);}};
        var feedback=TextLabel("",34);var button=ActionButton("表示設定を保存");box.Controls.Add(button);box.Controls.Add(feedback);
        button.Click+=delegate{
            try{var schedule=ReadDisplayScheduleInput();var preference=new DashboardPreferences{fixedDetails=dashboardFixed.Checked,returnMinutes=(int)dashboardMinutes.Value};preference.Save();schedule.Save();displaySchedule=schedule;if(dashboard!=null)dashboard.ApplyPreferences(preference);feedback.Text="表示設定を保存しました。";}
            catch(ArgumentException error){feedback.Text=error.Message;}
            catch{feedback.Text="表示設定を保存できませんでした。";}
        };
    }
    DisplaySchedulePreferences ReadDisplayScheduleInput(){
        if(!displayPeriods.EndEdit())throw new ArgumentException("時刻の入力を確定してください。");
        var periods=new List<DisplayOffPeriod>();
        foreach(DataGridViewRow row in displayPeriods.Rows){DateTime start,end;
            if(!DateTime.TryParseExact(Convert.ToString(row.Cells["Start"].Value),"HH:mm",System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out start)||!DateTime.TryParseExact(Convert.ToString(row.Cells["End"].Value),"HH:mm",System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out end))throw new ArgumentException("時刻は08:00のようにHH:mm形式で入力してください。");
            periods.Add(new DisplayOffPeriod{start=start.Hour*60+start.Minute,end=end.Hour*60+end.Minute});}
        var value=new DisplaySchedulePreferences{enabled=automaticDisplay.Checked,periods=periods.ToArray()};value.Validate();return value;
    }
    bool SleepProtectionReady {get{return powerHeld&&serverPowerHeld;}}
    bool DisplayScheduleEligible(){return !closing&&connected&&currentPhase=="ready"&&SleepProtectionReady&&OnAC();}
    void TickDisplaySchedule(){
        if(displayService==null)return;
        var state=displayService.Snapshot;powerHeld=state.Protected;
        if(state.PowerEpoch!=displayPowerEpoch){displayPowerEpoch=state.PowerEpoch;serverPowerHeld=false;Send("power/renew",null);}
        displayService.Update(displaySchedule,!closing&&connected&&currentPhase=="ready"&&serverPowerHeld&&OnAC(),dashboard!=null&&dashboard.Visible);
        if(dashboard!=null)dashboard.SetDisplaySuppressed(state.Managed&&!state.On);
        displayScheduleStatus.Text=state.Failed?(state.Error??"画面の切替を確認できません。診断ログを確認してください。"):state.Managed?state.Confirmed?(state.On?"画面制御：点灯を確認":"画面制御：消灯を確認"):(state.On?"画面制御：点灯を要求中":"画面制御：消灯を要求中"):displaySchedule.enabled?"画面制御：待機中":"自動消灯・点灯：無効";
        ShowPowerState();screen.Enabled=DisplayScheduleEligible();
    }
    static string PresencePreferencePath(){return Path.Combine(Environment.GetEnvironmentVariable("BATHJUN_DATA_DIR")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"BathjunData"),"dashboard-presence.txt");}
    static bool ReadPresencePreference(){try{return File.ReadAllText(PresencePreferencePath()).Trim()=="enabled";}catch{return false;}}
    void SavePresencePreference(){try{File.WriteAllText(PresencePreferencePath(),presenceEnabled.Checked?"enabled":"disabled");}catch{MessageBox.Show(this,"人感センサーの設定を保存できませんでした。");}}
    public void SetPublicMode(bool value){publicMode=value;}
    async void CheckForUpdates(bool unattended=false){
        if(updatePreparing)return;updatePreparing=true;automaticUpdate=new CancellationTokenSource();var cancel=automaticUpdate.Token;string download=null;
        try{
            if(!connected||currentPhase!="ready"||serverPid<=0)throw new InvalidOperationException("サーバーが稼働状態になってから確認してください。");
            if(unattended&&!await CanAutomaticallyUpdate())return;
            string root=ServerUpdate.InstallRoot,current=ServerUpdate.VersionAt(root);bool portable=!File.Exists(Path.Combine(root,"Uninstall.exe"));
            releases.Text="確認を中止";
            var available=await Task.Run(()=>AutomaticUpdate.Check(current,portable,cancel));cancel.ThrowIfCancellationRequested();if(closing||IsDisposed)return;
            if(available==null){if(!unattended)MessageBox.Show(this,"現在のバージョン "+current+" は最新です。");else{autoUpdatePreferences.checkedDay=DateTime.UtcNow.AddHours(9).ToString("yyyy-MM-dd");SaveAutomaticUpdate();updateFeedback.Text="最新バージョンを確認しました。";}return;}
            if(!unattended&&MessageBox.Show(this,current+" → "+available.release.tag_name.Substring(1)+" に更新できます。\nダウンロードして更新しますか？\n\n予約データは保持します。ダウンロード中はサーバーを継続し、適用時に一時停止して再起動します。","ふろじゅんの更新",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
            var progress=new Progress<int>(percent=>{if(automaticUpdate!=null&&!cancel.IsCancellationRequested&&releases.Enabled&&!closing&&!IsDisposed)releases.Text="取得中 "+percent+"%（中止）";});
            download=await Task.Run(()=>AutomaticUpdate.Download(available,current,value=>((IProgress<int>)progress).Report(value),cancel));cancel.ThrowIfCancellationRequested();
            if(closing||IsDisposed)return;if(pendingSave!=null||pendingSecurity!=null||pendingAnnouncement!=null)throw new InvalidOperationException("保存中の操作があります。完了後にもう一度更新してください。");
            if(unattended&&!await CanAutomaticallyUpdate()){updateFeedback.Text="入浴予定が近いため、更新を見送りました。";return;}
            releases.Enabled=false;releases.Text="更新を準備中…";
            var helper=await Task.Run(()=>ServerUpdate.Stage(download,root,serverPid,publicMode));
            if(dashboard!=null)dashboard.Close();if(Send("stop",null)==null){try{helper.Kill();}catch{}throw new IOException("サーバーを停止できませんでした。もう一度お試しください。");}
        }catch(OperationCanceledException){}
        catch(UpdateUnavailableException error){if(unattended){updateFeedback.Text=error.Message;nextAutoAttempt=DateTime.UtcNow.AddHours(1);}else if(!cancel.IsCancellationRequested&&!closing&&!IsDisposed){try{Process.Start(new ProcessStartInfo(ServerUpdate.ReleaseUrl){UseShellExecute=true});}catch(Exception){MessageBox.Show(this,error.Message+"\n\nブラウザーで次のURLを開いてください。\n"+ServerUpdate.ReleaseUrl,"リリースページ");}}}
        catch(Exception error){if(unattended){updateFeedback.Text=error.Message;nextAutoAttempt=DateTime.UtcNow.AddHours(1);}else if(!cancel.IsCancellationRequested&&!closing&&!IsDisposed)MessageBox.Show(this,error.Message+"\n\n配布ページ："+ServerUpdate.ReleaseUrl,"更新を確認できませんでした");}
        finally{if(download!=null)try{Directory.Delete(Path.GetDirectoryName(download),true);}catch{}automaticUpdate.Dispose();automaticUpdate=null;updatePreparing=false;if(!closing&&!IsDisposed){releases.Enabled=true;releases.Text="最新版を確認";}}
    }
    async void UpdateServer(){
        if(updatePreparing)return;
        try {
            if(!connected||currentPhase!="ready"||serverPid<=0){MessageBox.Show(this,"サーバーが稼働状態になってから更新してください。");return;}
            if(pendingSave!=null||pendingSecurity!=null||pendingAnnouncement!=null){MessageBox.Show(this,"設定の保存・操作が終わってから更新してください。");return;}
            string root=ServerUpdate.InstallRoot;
            if(!File.Exists(Path.Combine(root,"Uninstall.exe"))){MessageBox.Show(this,"ZIP版は新しいZIPを別のフォルダーへ展開し、停止後に「はじめる.cmd」を開いて更新してください。テストデータは引き継ぎます。");return;}
            updatePreparing=true;
            using(var picker=new OpenFileDialog{Title="ダウンロードしたふろじゅんのインストーラー",Filter="Windowsインストーラー (*.exe)|*.exe",CheckFileExists=true,Multiselect=false,AutoUpgradeEnabled=false}) {
                // The classic picker avoids optional shell/COM components. Opening it
                // must also be inside the catch, not just the installer validation.
                if(picker.ShowDialog(this)!=DialogResult.OK)return;
                UseWaitCursor=true;
                string selected=picker.FileName;
                var current=ServerUpdate.ParseVersion(ServerUpdate.VersionAt(root));var next=await Task.Run(()=>ServerUpdate.ValidateInstaller(selected,current));
                if(MessageBox.Show(this,"バージョン "+current+" → "+next+" に更新します。\n予約データは残し、更新中はアクセスと通知を停止します。完了後は同じ起動方法で再起動します。\n\nGitHubの公式Releaseから取得したファイルであることを確認してください。\nSHA-256ファイルを同じ場所へ置いた場合は照合します。","ふろじゅんの更新",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
                var helper=await Task.Run(()=>ServerUpdate.Stage(selected,root,serverPid,publicMode));
                if(dashboard!=null)dashboard.Close();
                if(Send("stop",null)==null){try{helper.Kill();}catch{}throw new IOException("停止を依頼できませんでした。もう一度お試しください。");}
            }
        }catch(Exception error){MessageBox.Show(this,error.Message,"更新できませんでした");}
        finally{updatePreparing=false;UseWaitCursor=false;}
    }
    void OpenDashboard(){if(dashboard!=null){dashboard.Activate();return;}try{dashboard=new DashboardForm(()=>Send("dashboard/get",null),presenceEnabled.Checked);dashboard.ApplyPreferences(DashboardPreferences.Read());dashboard.SetDisplaySuppressed(displayService!=null&&displayService.Snapshot.Managed&&!displayService.Snapshot.On);dashboard.Report=entry=>Send("bath/complete",new{memberId=entry.memberId,day=entry.day,revision=entry.revision});}catch{MessageBox.Show(this,"ダッシュボードのフォントを読み込めませんでした。アプリを上書きインストールするか、ZIPをすべて展開し直してください。");return;}presenceEnabled.Enabled=false;screen.Enabled=SleepProtectionReady&&OnAC()&&connected&&currentPhase=="ready";dashboard.FormClosed+=delegate{dashboard=null;presenceEnabled.Enabled=true;RenewPower();};dashboard.Show(this);}
    void ShowPowerState(){powerState.Text=SleepProtectionReady?"自動スリープ防止：有効（サーバー終了時に解除）\nAC電源で使ってください。電源ボタン・カバー閉じの手動スリープは防ぎません。":currentPhase!="ready"?"自動スリープ防止：サーバーの起動を待っています。":"自動スリープ防止を有効にできませんでした。\nアプリを更新し直すか、Windowsの電源設定を確認してください。消灯は無効です。";powerState.ForeColor=SleepProtectionReady||currentPhase!="ready"?Color.DarkGreen:Color.Firebrick;}

    void ShowPanel(){if(displayService!=null)displayService.RequestOn();TickDisplaySchedule();Show();WindowState=FormWindowState.Normal;Activate();}
    bool OnAC(){return SystemInformation.PowerStatus.PowerLineStatus==PowerLineStatus.Online;}
    void RenewPower(){if(displayService!=null)displayService.Renew();ShowPowerState();screen.Enabled=DisplayScheduleEligible();}
    void TurnScreenOff(){if(!OnAC()){ShowPanel();MessageBox.Show(this,"画面を消してサーバーを継続するには、AC電源につないでください。");return;}if(!DisplayScheduleEligible()||displayService==null){ShowPanel();return;}displayService.RequestOff();}

    void StopServer(){if(!connected)return;if(MessageBox.Show(this,"サーバーを停止しますか？家族からのアクセスと通知送信が止まります。","ふろじゅん",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)==DialogResult.OK){screen.Enabled=false;Send("stop",null);}}
    void BuildSettings(TabPage page) {
        var box=new FlowLayoutPanel{Dock=DockStyle.Top,AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false};page.Controls.Add(box);
        box.Controls.Add(TextLabel("メンバー（名前・利用するかどうか）",30));
        members.Size=new Size(550,200);members.AutoGenerateColumns=false;members.AllowUserToAddRows=false;members.AllowUserToDeleteRows=false;members.RowHeadersVisible=false;members.Columns.Add(new DataGridViewTextBoxColumn{Name="Id",Visible=false});members.Columns.Add(new DataGridViewTextBoxColumn{Name="Name",HeaderText="名前",Width=350,MaxInputLength=30});members.Columns.Add(new DataGridViewCheckBoxColumn{Name="Active",HeaderText="利用する",Width=110});box.Controls.Add(members);
        var addRow=new FlowLayoutPanel{Width=550,AutoSize=true};
        addRow.Controls.Add(new Label{Text="追加する名前",AutoSize=true,Margin=new Padding(0,12,8,0)});
        newMemberName.Width=270;newMemberName.MaxLength=30;newMemberName.AccessibleName="追加するメンバー名";newMemberName.Margin=new Padding(0,10,8,0);newMemberName.Enabled=false;addRow.Controls.Add(newMemberName);
        addMember.Enabled=false;addMember.Click+=delegate{AddMemberFromInput(true);};addRow.Controls.Add(addMember);box.Controls.Add(addRow);
        var orderRow=new FlowLayoutPanel{Width=550,AutoSize=true};orderMode.DropDownStyle=ComboBoxStyle.DropDownList;orderMode.Items.AddRange(new object[]{"毎日抽選","固定順"});orderMode.Width=140;orderMode.SelectedIndexChanged+=delegate{UpdateDrawControls();};orderRow.Controls.Add(orderMode);var up=ActionButton("選択行を上へ");var down=ActionButton("選択行を下へ");up.Click+=delegate{MoveMember(-1);};down.Click+=delegate{MoveMember(1);};orderRow.Controls.Add(up);orderRow.Controls.Add(down);box.Controls.Add(orderRow);
        box.Controls.Add(TextLabel("固定順は表の上から順です。「入らない/様子見」の人は末尾へ、利用停止の人は対象外にします。切り替えは翌日分から反映します。",64));
        box.Controls.Add(TextLabel("名前を入力して「メンバーを追加」→「設定を保存」。使わない人は「利用する」を外します。既存の予約と履歴は残ります。",68));
        ignoreLowerPriorityWishes.Text="下位の人の希望と重なっても自動確定する";ignoreLowerPriorityWishes.AutoSize=true;box.Controls.Add(ignoreLowerPriorityWishes);
        box.Controls.Add(TextLabel("この設定は保存後すぐ反映します。確定済みの予約とは重ねません。終了時刻と次の開始時刻が同じ場合は重複になりません。",64));
        var boundaryRow=new FlowLayoutPanel{Width=550,AutoSize=true};boundaryRow.Controls.Add(new Label{Text="予約・スタンプの区切り",AutoSize=true,Margin=new Padding(0,7,15,0)});boundaryRow.Controls.Add(bookingCutoff);box.Controls.Add(boundaryRow);
        box.Controls.Add(TextLabel("「今日」は0:00で切り替わります。区切りが7:00なら、今日の予約は今日7:00〜翌7:00です。抽選・予約はその日の0:00から始められます。",64));
        drawRestricted.Text="抽選できる時間帯を制限する";drawRestricted.AutoSize=true;drawRestricted.CheckedChanged+=delegate{UpdateDrawControls();};box.Controls.Add(drawRestricted);
        var drawRow=new FlowLayoutPanel{Width=550,AutoSize=true};drawRow.Controls.Add(new Label{Text="抽選",AutoSize=true,Margin=new Padding(0,7,15,0)});drawRow.Controls.Add(drawStart);drawRow.Controls.Add(new Label{Text="〜",AutoSize=true});drawRow.Controls.Add(drawEnd);box.Controls.Add(drawRow);
        var durationRow=new FlowLayoutPanel{Width=550,AutoSize=true};durationRow.Controls.Add(new Label{Text="1回の時間：最小",AutoSize=true,Margin=new Padding(0,7,5,0)});durationRow.Controls.Add(minimum);durationRow.Controls.Add(new Label{Text="〜最大",AutoSize=true});durationRow.Controls.Add(maximum);durationRow.Controls.Add(new Label{Text="分",AutoSize=true});box.Controls.Add(durationRow);
        var stepRow=new FlowLayoutPanel{Width=550,AutoSize=true};stepRow.Controls.Add(new Label{Text="予約の刻み幅（分）",AutoSize=true,Margin=new Padding(0,7,15,0)});step.DropDownStyle=ComboBoxStyle.DropDownList;step.Items.AddRange(new object[]{5,10,15,30});step.Width=100;stepRow.Controls.Add(step);box.Controls.Add(stepRow);
        saveState.Size=new Size(550,60);box.Controls.Add(saveState);save.Text="設定を保存";save.Size=new Size(180,44);save.Enabled=false;save.Click+=delegate{SaveSettings();};box.Controls.Add(save);var reload=ActionButton("設定を再読込");reload.Click+=delegate{Send("settings/get",null);};box.Controls.Add(reload);
    }
    void BuildSecurity(TabPage page) {
        var box=new FlowLayoutPanel{Dock=DockStyle.Top,AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false};page.Controls.Add(box);
        box.Controls.Add(TextLabel("パスワードの確認・変更",32));
        box.Controls.Add(TextLabel("現在のパスワードは表示・復元できません。設定済みか確認し、忘れた場合はここで新しいものに変更できます。",62));
        passwordTarget.Width=550;passwordTarget.DropDownStyle=ComboBoxStyle.DropDownList;box.Controls.Add(passwordTarget);
        passwordTarget.SelectedIndexChanged+=delegate{passwordInput.Clear();passwordConfirm.Clear();securityState.Text="入力が現在のものか確認、または新しいパスワードへ変更できます。";};
        box.Controls.Add(TextLabel("確認するパスワード／変更後の新しいパスワード",32));passwordInput.Width=550;passwordInput.MaxLength=128;passwordInput.UseSystemPasswordChar=true;box.Controls.Add(passwordInput);
        box.Controls.Add(TextLabel("変更する場合は、同じパスワードをもう一度",32));passwordConfirm.Width=550;passwordConfirm.MaxLength=128;passwordConfirm.UseSystemPasswordChar=true;box.Controls.Add(passwordConfirm);
        var show=new CheckBox{Text="入力した内容を表示",AutoSize=true};show.CheckedChanged+=delegate{passwordInput.UseSystemPasswordChar=passwordConfirm.UseSystemPasswordChar=!show.Checked;};box.Controls.Add(show);
        var actions=new FlowLayoutPanel{Width=550,AutoSize=true};actions.Controls.Add(verifyPassword);actions.Controls.Add(changePassword);box.Controls.Add(actions);verifyPassword.Click+=delegate{PasswordAction(false);};changePassword.Click+=delegate{PasswordAction(true);};
        securityState.Size=new Size(550,84);box.Controls.Add(securityState);var reload=ActionButton("パスワードの設定状態を再読込");reload.Click+=delegate{Send("security/get",null);};box.Controls.Add(reload);
        box.Controls.Add(TextLabel("全データのリセット",42));box.Controls.Add(TextLabel("全メンバー・予約・希望・抽選・時間設定・パスワード・パスキー・通知登録を削除します。家族用リンクも更新し、全員ログアウトします。",82));resetData.ForeColor=Color.Firebrick;box.Controls.Add(resetData);resetData.Click+=delegate{ResetData();};
        SetSecurityBusy(true);
    }
    void SetSecurityBusy(bool value){verifyPassword.Enabled=changePassword.Enabled=resetData.Enabled=!value&&connected;if(!value&&pendingSave==null)save.Enabled=connected;}
    void FillSecurity(SecurityInfo info) {
        object previous=(passwordTarget.SelectedItem as AccountChoice)==null?null:((AccountChoice)passwordTarget.SelectedItem).Target;
        passwordTarget.Items.Clear();passwordTarget.Items.Add(new AccountChoice{Target="family",Title="家族共通の合い言葉",Configured=info.familyConfigured});
        foreach(var member in info.members)passwordTarget.Items.Add(new AccountChoice{Target=member.id,Title=member.name,Configured=member.passwordSet});
        passwordTarget.SelectedIndex=0;for(int i=0;i<passwordTarget.Items.Count;i++)if(object.Equals(((AccountChoice)passwordTarget.Items[i]).Target,previous))passwordTarget.SelectedIndex=i;
        SetSecurityBusy(pendingSecurity!=null);
    }
    void PasswordAction(bool change) {
        if(pendingSave!=null||pendingSecurity!=null)return;
        var choice=passwordTarget.SelectedItem as AccountChoice;if(choice==null)return;
        string password=passwordInput.Text;
        if(change) {
            int minimum=choice.Target is string?8:4;
            if(password.Length<minimum||password!=passwordConfirm.Text){MessageBox.Show(this,"パスワードは"+minimum+"文字以上で、確認欄にも同じ内容を入力してください。");return;}
            string warning=choice.Target is string?"全員のログイン・パスキー・通知登録が解除されます。":"この人のログイン・パスキー・通知登録が解除されます。";
            if(MessageBox.Show(this,warning+"新しいパスワードへ変更しますか？","パスワード変更",MessageBoxButtons.OKCancel,MessageBoxIcon.Warning)!=DialogResult.OK)return;
        }
        pendingSecurity=Send(change?"security/password":"security/verify",new{target=choice.Target,password=password});
        passwordInput.Clear();passwordConfirm.Clear();if(pendingSecurity!=null){SetSecurityBusy(true);save.Enabled=false;securityState.Text=change?"変更しています…":"確認しています…";securityTimeout.Start();}
    }
    void ResetData() {
        if(pendingSave!=null||pendingSecurity!=null)return;
        using(var confirm=new Form{Text="全データのリセット確認",ClientSize=new Size(470,250),StartPosition=FormStartPosition.CenterParent,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false}) {
            confirm.SuspendLayout();confirm.AutoScaleDimensions=new SizeF(96F,96F);confirm.AutoScaleMode=AutoScaleMode.Dpi;
            var explanation=new Label{Text="すべての設定・メンバー・パスワード・予約履歴を削除します。元には戻せません。\n\n実行する場合は「リセット」と入力してください。",Location=new Point(18,16),Size=new Size(430,105)};
            var input=new TextBox{Location=new Point(18,126),Width=430};var execute=new Button{Text="全データを削除する",Location=new Point(18,180),Size=new Size(220,44),Enabled=false,DialogResult=DialogResult.OK};var cancel=new Button{Text="キャンセル",Location=new Point(250,180),Size=new Size(180,44),DialogResult=DialogResult.Cancel};input.TextChanged+=delegate{execute.Enabled=input.Text=="リセット";};confirm.Controls.AddRange(new Control[]{explanation,input,execute,cancel});confirm.CancelButton=cancel;
            confirm.ResumeLayout(true);
            if(confirm.ShowDialog(this)!=DialogResult.OK)return;
        }
        newMemberName.Clear();
        pendingSecurity=Send("data/reset",new{confirmation="RESET_ALL_DATA"});if(pendingSecurity!=null){SetSecurityBusy(true);save.Enabled=false;securityState.Text="リセットしています…";securityTimeout.Start();}
    }
    void UpdateDrawControls(){drawRestricted.Enabled=orderMode.SelectedIndex!=1;drawStart.Enabled=drawEnd.Enabled=orderMode.SelectedIndex!=1&&drawRestricted.Checked;}
    static DateTime ToClock(int minute){return DateTime.Today.AddMinutes(minute%1440);}
    static int Minutes(DateTimePicker picker){return picker.Value.Hour*60+picker.Value.Minute;}
    void FillSettings(Settings settings) {
        members.Rows.Clear();foreach(var member in settings.members)members.Rows.Add(member.id,member.name,member.active);
        settingsLoaded=true;newMemberName.Enabled=addMember.Enabled=true;
        ignoreLowerPriorityWishes.Checked=settings.ignoreLowerPriorityWishes;
        rewardExtension.Increment=settings.current.step;
        var rule=settings.upcoming;drawRestricted.Checked=rule.lotteryTimeRestricted;orderMode.SelectedIndex=rule.orderMode=="fixed"?1:0;bookingCutoff.Value=ToClock(rule.bookingCutoff);drawStart.Value=ToClock(rule.lotteryStart);drawEnd.Value=ToClock(rule.lotteryEnd);minimum.Value=rule.minDuration;maximum.Value=rule.maxDuration;step.SelectedItem=rule.step;
        saveState.Text="時間の設定は "+settings.effectiveDay+" 分から反映します。今日の予約・時間設定は変えません。追加メンバーは次の順番決定から参加します。";save.Enabled=true;
    }
    void MoveMember(int delta) {
        members.EndEdit();if(members.CurrentRow==null||members.CurrentRow.IsNewRow)return;
        int index=members.CurrentRow.Index,target=index+delta;if(target<0||target>=members.Rows.Count||members.Rows[target].IsNewRow)return;
        var first=members.Rows[index];var second=members.Rows[target];
        for(int column=0;column<members.Columns.Count;column++){var value=first.Cells[column].Value;first.Cells[column].Value=second.Cells[column].Value;second.Cells[column].Value=value;}
        members.CurrentCell=members.Rows[target].Cells["Name"];
    }
    bool CommitMemberEdits() {
        if((!members.IsCurrentCellDirty||members.CommitEdit(DataGridViewDataErrorContexts.Commit))&&(!members.IsCurrentCellInEditMode||members.EndEdit()))return true;
        MessageBox.Show(this,"入力中のメンバー名を確認してください。");return false;
    }
    bool AddMemberFromInput(bool focusInput) {
        if(!settingsLoaded||pendingSave!=null||pendingSecurity!=null)return false;
        if(!CommitMemberEdits())return false;
        string name=newMemberName.Text.Trim().Normalize(NormalizationForm.FormC);
        if(name.Length==0||name.Length>30){MessageBox.Show(this,"追加する名前を1〜30文字で入力してください。");return false;}
        foreach(char character in name)if(char.IsControl(character)){MessageBox.Show(this,"名前に改行や制御文字は使えません。");return false;}
        foreach(DataGridViewRow row in members.Rows)if(Convert.ToString(row.Cells["Name"].Value).Trim().Normalize(NormalizationForm.FormC)==name){MessageBox.Show(this,"同じ名前はすでに追加されています。");return false;}
        if(members.Rows.Count>=50){MessageBox.Show(this,"メンバーは50人まで追加できます。");return false;}
        int index=members.Rows.Add(null,name,true);members.CurrentCell=members.Rows[index].Cells["Name"];
        newMemberName.Clear();saveState.Text="メンバーを追加しました。「設定を保存」で確定します。";
        if(focusInput)newMemberName.Focus();return true;
    }
    void SaveSettings() {
        if(!settingsLoaded||pendingSave!=null||pendingSecurity!=null)return;
        if(!CommitMemberEdits())return;
        if(!string.IsNullOrWhiteSpace(newMemberName.Text)&&!AddMemberFromInput(false))return;
        var rows=new List<object>();
        foreach(DataGridViewRow row in members.Rows){if(row.IsNewRow)continue;string name=Convert.ToString(row.Cells["Name"].Value);int id=row.Cells["Id"].Value==null?0:Convert.ToInt32(row.Cells["Id"].Value);if(id==0 && string.IsNullOrWhiteSpace(name))continue;rows.Add(new{id=id,name=name,active=Convert.ToBoolean(row.Cells["Active"].Value)});}
        var schedule=new Schedule{bookingCutoff=Minutes(bookingCutoff),lotteryTimeRestricted=drawRestricted.Checked,lotteryStart=Minutes(drawStart),lotteryEnd=Minutes(drawEnd),minDuration=(int)minimum.Value,maxDuration=(int)maximum.Value,step=step.SelectedItem==null?15:(int)step.SelectedItem,orderMode=orderMode.SelectedIndex==1?"fixed":"random"};
        if(pendingSecurity!=null)return;save.Enabled=false;saveState.Text="保存しています…";pendingSave=Send("settings/save",new{members=rows,schedule=schedule,ignoreLowerPriorityWishes=ignoreLowerPriorityWishes.Checked});if(pendingSave!=null)saveTimeout.Start();else save.Enabled=true;
    }
    string Send(string command,object payload) {
        string id=Interlocked.Increment(ref sequence).ToString();
        if(outbox!=null&&outbox.Post(new{token=token,command=command,id=id,payload=payload}))return id;
        saveState.Text="サーバーに送信できませんでした。接続を確認してください。";return null;
    }
    void WriteFailed(Exception error){try{BeginInvoke((MethodInvoker)delegate{if(closing)return;saveTimeout.Stop();pendingSave=null;pendingSecurity=null;securityTimeout.Stop();SetSecurityBusy(false);save.Enabled=connected;saveState.Text="サーバーに送信できませんでした。再起動してください。";});}catch{}}
    void BeginRead(){reader=new Thread(delegate(){try{pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous);pipe.Connect(10000);writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true);var input=new StreamReader(pipe,Encoding.UTF8,false,4096,true);outbox=new PanelOutbox(outgoing=>{writer.WriteLine(outgoing);writer.Flush();},WriteFailed);connected=true;Send("status",null);Send("settings/get",null);Send("security/get",null);Send("items/get",null);Send("announcements/get",null);string line;while((line=input.ReadLine())!=null){var reply=json.Deserialize<Reply>(line);BeginInvoke((MethodInvoker)delegate{if(closing)return;if(reply.show)ShowPanel();if(reply.readiness!=null&&reply.id==readinessRequest&&updateReadiness!=null)updateReadiness.TrySetResult(reply.ok&&!reply.readiness.busy);if(reply.id==pendingAnnouncement&&pendingAnnouncement!=null){pendingAnnouncement=null;announcementSave.Enabled=true;announcementFeedback.Text=reply.ok?"保存しました。":reply.error;}if(reply.announcements!=null)FillAnnouncements(reply.announcements);if(reply.rewards!=null)FillRewards(reply.rewards);if(reply.dashboard!=null&&dashboard!=null)dashboard.UpdateData(reply.dashboard);bool secured=reply.id==pendingSecurity&&pendingSecurity!=null;if(secured){pendingSecurity=null;securityTimeout.Stop();SetSecurityBusy(false);}bool saved=reply.id==pendingSave&&pendingSave!=null;if(saved){pendingSave=null;saveTimeout.Stop();save.Enabled=true;}if(!reply.ok){distributeItems.Enabled=saveRewards.Enabled=true;if(dashboard!=null)dashboard.Fail("データを更新できませんでした");save.Enabled=true;MessageBox.Show(this,reply.error ?? "操作を完了できませんでした。","ふろじゅん");}if(reply.state!=null){currentPhase=reply.state.phase;serverPid=reply.state.pid;serverPowerHeld=reply.state.serverPowerHeld;ShowPowerState();TickDisplaySchedule();status.Text=reply.state.phase=="ready"?"● サーバー稼働中":reply.state.phase=="stopping"?"停止しています…":"準備中";detail.Text=reply.state.detail;link.Text=reply.state.url??"";copy.Enabled=open.Enabled=link.Text.Length>0;screen.Enabled=SleepProtectionReady&&OnAC()&&reply.state.phase=="ready";}if(reply.settings!=null){FillSettings(reply.settings);if(pendingSave!=null||pendingSecurity!=null)save.Enabled=false;}if(reply.security!=null)FillSecurity(reply.security);if(reply.verification!=null)securityState.Text=reply.verification.matches?"入力したパスワードは現在のものと一致しています。":reply.verification.configured?"入力したパスワードは一致しません。新しいものへ変更できます。":"パスワードはまだ設定されていません。";if(reply.notice!=null){securityState.Text=reply.notice;passwordInput.Clear();passwordConfirm.Clear();}if(secured&&!reply.ok)securityState.Text=reply.error;if(saved&&reply.ok){saveState.Text="保存しました。時間の設定は "+reply.settings.effectiveDay+" 分から反映します。";Send("security/get",null);}});}}catch(Exception error){Console.Error.WriteLine("管理画面の接続処理でエラーが発生しました。\n"+error);}finally{connected=false;try{BeginInvoke((MethodInvoker)delegate{canClose=true;Close();});}catch{}}});reader.IsBackground=true;reader.Start();}
}
internal static class Program {
    [STAThread] static int Main(string[] args){try{Console.OutputEncoding=new UTF8Encoding(false);Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);if(args.Length>0&&args[0]=="--apply-update"){ServerUpdate.Run(args);return 0;}if(args.Length<2)return 0;Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);var panel=new PanelForm(args[0],args[1],Array.IndexOf(args,"--minimized")>=0);panel.SetPublicMode(Array.IndexOf(args,"--public")>=0);Application.Run(panel);return 0;}catch(Exception error){Console.Error.WriteLine("サーバー操作画面を起動できませんでした。\n"+error);return 1;}}
}
