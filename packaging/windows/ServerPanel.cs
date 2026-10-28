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
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Runtime.Versioning;

[assembly: TargetFramework(".NETFramework,Version=v4.7.2", FrameworkDisplayName=".NET Framework 4.7.2")]

internal sealed class PowerLease : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Reason { public uint Version; public uint Flags; public IntPtr SimpleReason; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr PowerCreateRequest(ref Reason context);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool PowerSetRequest(IntPtr handle, int type);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool PowerClearRequest(IntPtr handle, int type);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,UIntPtr wParam,IntPtr lParam,uint flags,uint timeout,out UIntPtr result);
    IntPtr handle=IntPtr.Zero; bool system,execution;
    public bool Acquire() {
        Dispose();
        IntPtr reason=Marshal.StringToHGlobalUni("ふろじゅんの予約サーバーと通知送信を、画面消灯中も継続しています。");
        try {var context=new Reason{Version=0,Flags=1,SimpleReason=reason};handle=PowerCreateRequest(ref context);}
        finally {Marshal.FreeHGlobal(reason);}
        if(handle==IntPtr.Zero || handle==new IntPtr(-1)){handle=IntPtr.Zero;return false;}
        system=PowerSetRequest(handle,0); // PowerRequestSystemRequired
        execution=PowerSetRequest(handle,3); // PowerRequestExecutionRequired (Modern Standby)
        if(system&&execution)return true;
        Dispose();return false;
    }
    public static bool ScreenOff() {UIntPtr result;return SendMessageTimeout(new IntPtr(0xffff),0x0112,new UIntPtr(0xf170),new IntPtr(2),2,1000,out result)!=IntPtr.Zero;}
    public void Dispose() {if(handle!=IntPtr.Zero){if(execution)PowerClearRequest(handle,3);if(system)PowerClearRequest(handle,0);CloseHandle(handle);handle=IntPtr.Zero;system=execution=false;}}
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
public sealed class Schedule {public int bathStart,bathEnd,lotteryStart,lotteryEnd,minDuration,maxDuration,step;public bool lotteryTimeRestricted;public string orderMode;public int[] fixedOrder;}
public sealed class Settings {public Member[] members;public Schedule current,upcoming;public string effectiveDay;}
public sealed class ServerState {public string phase,detail,url;}
public sealed class SecurityMember {public int id;public string name;public bool passwordSet;}
public sealed class SecurityInfo {public bool familyConfigured;public SecurityMember[] members;}
public sealed class Verification {public bool matches,configured;}
public sealed class AccountChoice {public object Target;public string Title;public bool Configured;public override string ToString(){return Title+(Configured?"（設定済み）":"（未設定）");}}
public sealed class Reply {public string id;public bool ok,show;public string error,notice;public ServerState state;public Settings settings;public SecurityInfo security;public Verification verification;}
internal sealed class PanelForm : Form {
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    readonly string pipeName,token;
    readonly PowerLease power=new PowerLease();
    readonly Label status=new Label(),detail=new Label(),powerState=new Label(),saveState=new Label();
    readonly TextBox link=new TextBox();readonly Button screen=new Button(),copy=new Button(),open=new Button(),save=new Button();
    readonly DataGridView members=new DataGridView();
    readonly DateTimePicker bathStart=Clock(),bathEnd=Clock(),drawStart=Clock(),drawEnd=Clock();
    readonly CheckBox nextDay=new CheckBox(),drawRestricted=new CheckBox();
    readonly NumericUpDown minimum=Number(),maximum=Number();readonly ComboBox step=new ComboBox(),orderMode=new ComboBox();
    readonly ComboBox passwordTarget=new ComboBox();
    readonly TextBox passwordInput=new TextBox(),passwordConfirm=new TextBox();
    readonly Label securityState=new Label();
    readonly Button verifyPassword=ActionButton("入力が現在のものか確認"),changePassword=ActionButton("新しいパスワードに変更"),resetData=ActionButton("全データをリセット");
    readonly System.Windows.Forms.Timer securityTimeout=new System.Windows.Forms.Timer{Interval=15000};
    string pendingSecurity;
    readonly NotifyIcon tray=new NotifyIcon();
    NamedPipeClientStream pipe;StreamWriter writer;Thread reader;bool connected,closing,canClose,powerHeld;string currentPhase="starting";
    int sequence;PanelOutbox outbox;string pendingSave;readonly System.Windows.Forms.Timer saveTimeout=new System.Windows.Forms.Timer{Interval=15000};
    static DateTimePicker Clock(){return new DateTimePicker{Format=DateTimePickerFormat.Custom,CustomFormat="HH:mm",ShowUpDown=true,Width=100};}
    static NumericUpDown Number(){return new NumericUpDown{Minimum=5,Maximum=1440,Increment=5,Width=85};}
    static Label TextLabel(string text,int height){return new Label{Text=text,AutoSize=false,Height=height,Dock=DockStyle.Top,Padding=new Padding(0,5,0,0)};}
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
        var stop=ActionButton("サーバーを停止して終了");stop.Click+=delegate{StopServer();};layout.Controls.Add(stop);
        layout.Controls.Add(TextLabel("×は通知領域にしまいます。スリープ防止はサーバー稼働中だけ有効で、終了すると解除します。AC電源につないで使ってください。",68));
        BuildSettings(config);var security=new TabPage("パスワード・リセット"){Padding=new Padding(16),AutoScroll=true};tabs.TabPages.Add(security);BuildSecurity(security);
        var menu=new ContextMenuStrip();menu.Items.Add("操作画面を開く",null,delegate{ShowPanel();});menu.Items.Add("画面だけ消す",null,delegate{TurnScreenOff();});menu.Items.Add("サーバーを停止",null,delegate{StopServer();});tray.Icon=Icon;tray.Text="ふろじゅん サーバー";tray.ContextMenuStrip=menu;tray.DoubleClick+=delegate{ShowPanel();};tray.Visible=true;
        Load+=delegate{powerHeld=power.Acquire();ShowPowerState();BeginRead();};
        Shown+=delegate{if(minimized){WindowState=FormWindowState.Minimized;Hide();}};
        FormClosing+=delegate(object sender,FormClosingEventArgs e){if(!canClose && e.CloseReason==CloseReason.UserClosing){e.Cancel=true;Hide();tray.ShowBalloonTip(2500,"ふろじゅん","サーバーは継続しています。通知領域のアイコンから操作画面に戻れます。",ToolTipIcon.Info);}};
        FormClosed+=delegate{closing=true;saveTimeout.Dispose();securityTimeout.Dispose();if(outbox!=null)outbox.Dispose();power.Dispose();tray.Visible=false;tray.Dispose();try{pipe.Dispose();}catch{}};
        ResumeLayout(true);
    }
    void ShowPowerState(){powerState.Text=powerHeld?"自動スリープ防止：有効（サーバー終了時に解除）\nAC電源で使ってください。電源ボタン・カバー閉じの手動スリープは防ぎません。":"自動スリープ防止を有効にできませんでした。\nWindowsの電源設定を確認してください。消灯ボタンは使えません。";powerState.ForeColor=powerHeld?Color.DarkGreen:Color.Firebrick;}
    void ShowPanel(){Show();WindowState=FormWindowState.Normal;Activate();}
    bool OnAC(){return SystemInformation.PowerStatus.PowerLineStatus==PowerLineStatus.Online;}
    void RenewPower(){power.Dispose();powerHeld=power.Acquire();ShowPowerState();screen.Enabled=powerHeld&&OnAC()&&connected&&currentPhase=="ready";}
    protected override void WndProc(ref Message message){base.WndProc(ref message);if(message.Msg==0x218 && (message.WParam.ToInt32()==7 || message.WParam.ToInt32()==18 || message.WParam.ToInt32()==10)){if(IsHandleCreated&&!closing)RenewPower();}}
    void TurnScreenOff(){if(!OnAC()){ShowPanel();MessageBox.Show(this,"画面を消してサーバーを継続するには、AC電源につないでください。");return;}RenewPower();if(!powerHeld || !connected || currentPhase!="ready"){ShowPanel();return;}var timer=new System.Windows.Forms.Timer{Interval=1000};timer.Tick+=delegate{timer.Stop();timer.Dispose();if(!closing && connected && currentPhase=="ready" && !PowerLease.ScreenOff())MessageBox.Show(this,"画面を消せませんでした。Windowsの表示設定を確認してください。");};timer.Start();}
    void StopServer(){if(!connected)return;if(MessageBox.Show(this,"サーバーを停止しますか？家族からのアクセスと通知送信が止まります。","ふろじゅん",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)==DialogResult.OK){screen.Enabled=false;Send("stop",null);}}
    void BuildSettings(TabPage page) {
        var box=new FlowLayoutPanel{Dock=DockStyle.Top,AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false};page.Controls.Add(box);
        box.Controls.Add(TextLabel("メンバー（名前・利用するかどうか）",30));
        members.Size=new Size(550,200);members.AutoGenerateColumns=false;members.AllowUserToDeleteRows=false;members.RowHeadersVisible=false;members.Columns.Add(new DataGridViewTextBoxColumn{Name="Id",Visible=false});members.Columns.Add(new DataGridViewTextBoxColumn{Name="Name",HeaderText="名前",Width=350,MaxInputLength=30});members.Columns.Add(new DataGridViewCheckBoxColumn{Name="Active",HeaderText="利用する",Width=110});members.DefaultValuesNeeded+=delegate(object sender,DataGridViewRowEventArgs e){e.Row.Cells["Active"].Value=true;};box.Controls.Add(members);
        var orderRow=new FlowLayoutPanel{Width=550,AutoSize=true};orderMode.DropDownStyle=ComboBoxStyle.DropDownList;orderMode.Items.AddRange(new object[]{"毎日抽選","固定順"});orderMode.Width=140;orderMode.SelectedIndexChanged+=delegate{UpdateDrawControls();};orderRow.Controls.Add(orderMode);var up=ActionButton("選択行を上へ");var down=ActionButton("選択行を下へ");up.Click+=delegate{MoveMember(-1);};down.Click+=delegate{MoveMember(1);};orderRow.Controls.Add(up);orderRow.Controls.Add(down);box.Controls.Add(orderRow);
        box.Controls.Add(TextLabel("固定順は表の上から順です。「入らない/様子見」の人は末尾へ、利用停止の人は対象外にします。切り替えは翌日分から反映します。",64));
        box.Controls.Add(TextLabel("末尾の空行から追加。履歴を残すため、削除の代わりに「利用する」を外します。名前と利用状態は保存後すぐ反映し、既存の予約は残ります。",68));
        var timeRow=new FlowLayoutPanel{Width=550,AutoSize=true};timeRow.Controls.Add(TextLabel("入浴",30));timeRow.Controls.Add(bathStart);timeRow.Controls.Add(new Label{Text="〜",AutoSize=true});timeRow.Controls.Add(bathEnd);nextDay.Text="翌日終了";nextDay.AutoSize=true;timeRow.Controls.Add(nextDay);box.Controls.Add(timeRow);
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
        pendingSecurity=Send("data/reset",new{confirmation="RESET_ALL_DATA"});if(pendingSecurity!=null){SetSecurityBusy(true);save.Enabled=false;securityState.Text="リセットしています…";securityTimeout.Start();}
    }
    void UpdateDrawControls(){drawRestricted.Enabled=orderMode.SelectedIndex!=1;drawStart.Enabled=drawEnd.Enabled=orderMode.SelectedIndex!=1&&drawRestricted.Checked;}
    static DateTime ToClock(int minute){return DateTime.Today.AddMinutes(minute%1440);}
    static int Minutes(DateTimePicker picker){return picker.Value.Hour*60+picker.Value.Minute;}
    void FillSettings(Settings settings) {
        members.Rows.Clear();foreach(var member in settings.members)members.Rows.Add(member.id,member.name,member.active);
        var rule=settings.upcoming;drawRestricted.Checked=rule.lotteryTimeRestricted;orderMode.SelectedIndex=rule.orderMode=="fixed"?1:0;bathStart.Value=ToClock(rule.bathStart);bathEnd.Value=ToClock(rule.bathEnd);nextDay.Checked=rule.bathEnd>=1440;drawStart.Value=ToClock(rule.lotteryStart);drawEnd.Value=ToClock(rule.lotteryEnd);minimum.Value=rule.minDuration;maximum.Value=rule.maxDuration;step.SelectedItem=rule.step;
        saveState.Text="時間の設定は "+settings.effectiveDay+" 分から反映します。今日の予約・時間設定は変えません。追加メンバーは次の順番決定から参加します。";save.Enabled=true;
    }
    void MoveMember(int delta) {
        members.EndEdit();if(members.CurrentRow==null||members.CurrentRow.IsNewRow)return;
        int index=members.CurrentRow.Index,target=index+delta;if(target<0||target>=members.Rows.Count||members.Rows[target].IsNewRow)return;
        var first=members.Rows[index];var second=members.Rows[target];
        for(int column=0;column<members.Columns.Count;column++){var value=first.Cells[column].Value;first.Cells[column].Value=second.Cells[column].Value;second.Cells[column].Value=value;}
        members.CurrentCell=members.Rows[target].Cells["Name"];
    }
    void SaveSettings() {
        members.EndEdit();var rows=new List<object>();
        foreach(DataGridViewRow row in members.Rows){if(row.IsNewRow)continue;string name=Convert.ToString(row.Cells["Name"].Value);int id=row.Cells["Id"].Value==null?0:Convert.ToInt32(row.Cells["Id"].Value);if(id==0 && string.IsNullOrWhiteSpace(name))continue;rows.Add(new{id=id,name=name,active=Convert.ToBoolean(row.Cells["Active"].Value)});}
        var schedule=new Schedule{bathStart=Minutes(bathStart),bathEnd=Minutes(bathEnd)+(nextDay.Checked?1440:0),lotteryTimeRestricted=drawRestricted.Checked,lotteryStart=Minutes(drawStart),lotteryEnd=Minutes(drawEnd),minDuration=(int)minimum.Value,maxDuration=(int)maximum.Value,step=step.SelectedItem==null?15:(int)step.SelectedItem,orderMode=orderMode.SelectedIndex==1?"fixed":"random"};
        if(pendingSecurity!=null)return;save.Enabled=false;saveState.Text="保存しています…";pendingSave=Send("settings/save",new{members=rows,schedule=schedule});if(pendingSave!=null)saveTimeout.Start();else save.Enabled=true;
    }
    string Send(string command,object payload) {
        string id=Interlocked.Increment(ref sequence).ToString();
        if(outbox!=null&&outbox.Post(new{token=token,command=command,id=id,payload=payload}))return id;
        saveState.Text="サーバーに送信できませんでした。接続を確認してください。";return null;
    }
    void WriteFailed(Exception error){try{BeginInvoke((MethodInvoker)delegate{if(closing)return;saveTimeout.Stop();pendingSave=null;pendingSecurity=null;securityTimeout.Stop();SetSecurityBusy(false);save.Enabled=connected;saveState.Text="サーバーに送信できませんでした。再起動してください。";});}catch{}}
    void BeginRead(){reader=new Thread(delegate(){try{pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous);pipe.Connect(10000);writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true);var input=new StreamReader(pipe,Encoding.UTF8,false,4096,true);outbox=new PanelOutbox(outgoing=>{writer.WriteLine(outgoing);writer.Flush();},WriteFailed);connected=true;Send("status",null);Send("settings/get",null);Send("security/get",null);string line;while((line=input.ReadLine())!=null){var reply=json.Deserialize<Reply>(line);BeginInvoke((MethodInvoker)delegate{if(closing)return;if(reply.show)ShowPanel();bool secured=reply.id==pendingSecurity&&pendingSecurity!=null;if(secured){pendingSecurity=null;securityTimeout.Stop();SetSecurityBusy(false);}bool saved=reply.id==pendingSave&&pendingSave!=null;if(saved){pendingSave=null;saveTimeout.Stop();save.Enabled=true;}if(!reply.ok){save.Enabled=true;MessageBox.Show(this,reply.error ?? "操作を完了できませんでした。","ふろじゅん");}if(reply.state!=null){currentPhase=reply.state.phase;status.Text=reply.state.phase=="ready"?"● サーバー稼働中":reply.state.phase=="stopping"?"停止しています…":"準備中";detail.Text=reply.state.detail;link.Text=reply.state.url??"";copy.Enabled=open.Enabled=link.Text.Length>0;screen.Enabled=powerHeld&&OnAC()&&reply.state.phase=="ready";}if(reply.settings!=null){FillSettings(reply.settings);if(pendingSave!=null||pendingSecurity!=null)save.Enabled=false;}if(reply.security!=null)FillSecurity(reply.security);if(reply.verification!=null)securityState.Text=reply.verification.matches?"入力したパスワードは現在のものと一致しています。":reply.verification.configured?"入力したパスワードは一致しません。新しいものへ変更できます。":"パスワードはまだ設定されていません。";if(reply.notice!=null){securityState.Text=reply.notice;passwordInput.Clear();passwordConfirm.Clear();}if(secured&&!reply.ok)securityState.Text=reply.error;if(saved&&reply.ok){saveState.Text="保存しました。時間の設定は "+reply.settings.effectiveDay+" 分から反映します。";Send("security/get",null);}});}}catch{}finally{connected=false;try{BeginInvoke((MethodInvoker)delegate{canClose=true;Close();});}catch{}}});reader.IsBackground=true;reader.Start();}
}
internal static class Program {
    [STAThread] static void Main(string[] args){if(args.Length<2)return;Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new PanelForm(args[0],args[1],args.Length>2&&args[2]=="--minimized"));}
}
