using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class DashboardOverlap { public int memberId,start,end; }
public sealed class DashboardEntry { public DashboardOverlap[] overlaps; public int memberId,start,duration; public string name,kind,startsAt,endsAt,emoji,color,revision,completedAt,day,ticket; }
public sealed class DashboardMember { public int id; public string name,status,emoji,color; public bool deferred; }
public sealed class DashboardData {
    public string day,now,phase,shareUrl; public int bathStart,bathEnd;
    public DashboardEntry current,next,afterNext; public DashboardEntry[] entries; public DashboardMember[] members; public string[] qr;
}
public sealed class DashboardPreferences {
    public bool fixedDetails; public int returnMinutes=1;
    static string FilePath {get{return Path.Combine(Environment.GetEnvironmentVariable("BATHJUN_DATA_DIR")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"BathjunData"),"dashboard-display.json");}}
    public static DashboardPreferences Read(){try{var value=new JavaScriptSerializer().Deserialize<DashboardPreferences>(File.ReadAllText(FilePath));if(value!=null&&value.returnMinutes>=1&&value.returnMinutes<=60)return value;}catch{}return new DashboardPreferences();}
    public void Save(){if(returnMinutes<1||returnMinutes>60)throw new ArgumentOutOfRangeException("returnMinutes");string path=FilePath;Directory.CreateDirectory(Path.GetDirectoryName(path));string temp=path+".tmp";File.WriteAllText(temp,new JavaScriptSerializer().Serialize(this));if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path);}
}
// Single native surface: no embedded browser or camera stream. All drawn content,
// including the QR quiet zone, moves periodically inside a safe margin.
internal sealed class DashboardForm : Form {
    public Action<DashboardEntry> Report;
    readonly List<KeyValuePair<RectangleF,DashboardEntry>> reportAreas=new List<KeyValuePair<RectangleF,DashboardEntry>>();
    float paintScale,paintDx,paintDy;bool reportBusy;
    readonly Action request;
    readonly bool usePresence;
    readonly PowerLease display=new PowerLease();
    readonly System.Windows.Forms.Timer clock=new System.Windows.Forms.Timer{Interval=1000};
    readonly System.Windows.Forms.Timer animation=new System.Windows.Forms.Timer{Interval=16};
    readonly Stopwatch elapsed=Stopwatch.StartNew();
    readonly HumanPresenceReader presence=new HumanPresenceReader();
    DashboardData data; double receivedAt; DateTime serverTime;
    readonly Dictionary<string,Font> textFonts=new Dictionary<string,Font>();
    bool disposed;
    double detailedUntil,transition,transitionFrom,transitionTarget,transitionStarted;
    DashboardPreferences preferences=new DashboardPreferences();
    bool Detailed { get { return preferences.fixedDetails||elapsed.Elapsed.TotalSeconds<detailedUntil; } }
    public void ApplyPreferences(DashboardPreferences value){preferences=value;detailedUntil=elapsed.Elapsed.TotalSeconds+value.returnMinutes*60;MoveTo(value.fixedDetails?1:0);if(!value.fixedDetails)detailedUntil=0;}
    void ShowDetails(){detailedUntil=elapsed.Elapsed.TotalSeconds+preferences.returnMinutes*60;MoveTo(1);Invalidate();}
    void MoveTo(double target){if(transitionTarget==target)return;transitionFrom=transition;transitionTarget=target;transitionStarted=elapsed.Elapsed.TotalSeconds;animation.Start();}
    void Animate(){double t=Math.Min(1,(elapsed.Elapsed.TotalSeconds-transitionStarted)/.42);double eased=t*t*(3-2*t);transition=transitionFrom+(transitionTarget-transitionFrom)*eased;if(t>=1)animation.Stop();Invalidate();}
    float Mix(float compact,float detailed){return compact+(detailed-compact)*(float)transition;}
    static RectangleF MixRect(RectangleF compact,RectangleF detailed,float t){return new RectangleF(compact.X+(detailed.X-compact.X)*t,compact.Y+(detailed.Y-compact.Y)*t,compact.Width+(detailed.Width-compact.Width)*t,compact.Height+(detailed.Height-compact.Height)*t);}
    void Reveal(Graphics g,RectangleF rect,Action draw){if(transition<=0)return;var state=g.Save();g.SetClip(new RectangleF(rect.X,rect.Y,rect.Width,rect.Height*(float)transition));draw();g.Restore(state);}
    bool held,waiting; double requestedAt; string problem="";
    public DashboardForm(Action request,bool usePresence):this(request,usePresence,Typeface()) {}
    public DashboardForm(Action request,bool usePresence,FontFamily typeface) {
        this.request=request;this.usePresence=usePresence;
        animation.Tick+=delegate{Animate();};
        AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        Text="ふろじゅん";FormBorderStyle=FormBorderStyle.None;WindowState=FormWindowState.Maximized;
        BackColor=Background;ForeColor=Ink;DoubleBuffered=true;KeyPreview=true;
        Font=new Font(typeface,12,FontStyle.Regular);
        KeyDown+=delegate(object sender,KeyEventArgs e){if(e.KeyCode==Keys.Escape||e.KeyCode==Keys.F11)Close();};
        // First tap always opens details; the return target only closes from details.
        MouseDown+=delegate(object sender,MouseEventArgs e){foreach(var area in reportAreas)if(area.Key.Contains(e.Location)){if(!reportBusy&&Report!=null){reportBusy=true;Report(area.Value);Invalidate();}return;}if(Detailed&&returnArea.Contains(e.Location))Close();else ShowDetails();};
        Shown+=delegate{held=display.Acquire(true);if(usePresence)presence.Start();Poll();clock.Start();};
        clock.Tick+=delegate{
            if(!held)held=display.Acquire(true);
            if(!waiting&&elapsed.Elapsed.TotalSeconds-requestedAt>=5)Poll();
            if(waiting&&elapsed.Elapsed.TotalSeconds-requestedAt>15){waiting=false;problem="更新が途絶えています";}
            MoveTo(Detailed?1:0);Invalidate();
        };

    }
    protected override void Dispose(bool disposing) {
        if(disposing&&!disposed){disposed=true;clock.Stop();clock.Dispose();animation.Stop();animation.Dispose();presence.Dispose();display.Dispose();foreach(var font in textFonts.Values)font.Dispose();textFonts.Clear();foreach(var icon in emojiImages.Values)if(icon!=null)icon.Dispose();emojiImages.Clear();}
        base.Dispose(disposing);
    }
    Font TextFont(float size,bool bold) {
        size=(float)Math.Round(size*2)/2;
        string key=size.ToString(CultureInfo.InvariantCulture)+(bold?"b":"r");Font value;
        if(!textFonts.TryGetValue(key,out value)){value=new Font(Font.FontFamily,size,bold?FontStyle.Bold:FontStyle.Regular,GraphicsUnit.Pixel);textFonts.Add(key,value);}
        return value;
    }
    void Poll(){waiting=true;requestedAt=elapsed.Elapsed.TotalSeconds;request();}
    public void UpdateData(DashboardData value){data=value;serverTime=DateTime.Parse(value.now,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal|DateTimeStyles.AssumeUniversal);receivedAt=elapsed.Elapsed.TotalSeconds;waiting=false;reportBusy=false;problem="";Invalidate();}
    public void Fail(string message){waiting=false;reportBusy=false;problem=message;Invalidate();}
    static string Time(int minute){return (minute>=1440?"翌":"")+(minute/60%24).ToString("00")+":"+(minute%60).ToString("00");}
    void Write(Graphics g,string text,float size,Color color,RectangleF rect,bool bold=false) {
        var font=TextFont(size,bold);
        using(var brush=new SolidBrush(color))
        using(var format=new StringFormat{Trimming=StringTrimming.EllipsisCharacter,FormatFlags=StringFormatFlags.NoWrap})g.DrawString(text??"",font,brush,rect,format);
    }
    static readonly Color Background=Color.FromArgb(24,29,23),Paper=Color.FromArgb(34,40,32),Line=Color.FromArgb(57,65,51),Ink=Color.FromArgb(211,217,201),Muted=Color.FromArgb(153,165,140),Green=Color.FromArgb(179,199,151),Orange=Color.FromArgb(215,151,104);
    RectangleF returnArea;
    static System.Drawing.Text.PrivateFontCollection sharedFonts;
    static FontFamily Typeface() {
        if(sharedFonts==null) {
            var fonts=new System.Drawing.Text.PrivateFontCollection();
            string folder=System.IO.Path.GetFullPath(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","app","public","fonts"));
            foreach(string style in new[]{"Regular","Bold"})fonts.AddFontFile(System.IO.Path.Combine(folder,"NotoSansJP-"+style+".ttf"));
            sharedFonts=fonts;
        }
        return sharedFonts.Families[0];
    }
    static System.Drawing.Drawing2D.GraphicsPath Rounded(RectangleF r,float radius) {
        float diameter=Math.Min(radius*2,Math.Min(r.Width,r.Height));
        var path=new System.Drawing.Drawing2D.GraphicsPath();
        path.AddArc(r.X,r.Y,diameter,diameter,180,90);path.AddArc(r.Right-diameter,r.Y,diameter,diameter,270,90);
        path.AddArc(r.Right-diameter,r.Bottom-diameter,diameter,diameter,0,90);path.AddArc(r.X,r.Bottom-diameter,diameter,diameter,90,90);path.CloseFigure();return path;
    }
    void Box(Graphics g,RectangleF rect,Color fill,Color border,float radius=20,bool dashed=false) {
        using(var path=Rounded(rect,radius))using(var brush=new SolidBrush(fill))using(var pen=new Pen(border,1)) {
            if(dashed)pen.DashStyle=System.Drawing.Drawing2D.DashStyle.Dash;
            g.FillPath(brush,path);g.DrawPath(pen,path);
        }
    }
    void Divider(Graphics g,float x,float y,float width){using(var pen=new Pen(Line,1))g.DrawLine(pen,x,y,x+width,y);}
    void Badge(Graphics g,string text,RectangleF rect,Color fg,Color fill) {Box(g,rect,fill,fill,8);Write(g,text,12,fg,new RectangleF(rect.X+9,rect.Y+5,rect.Width-15,22),true);}
    readonly Dictionary<string,Bitmap> emojiImages=new Dictionary<string,Bitmap>();
    static string EmojiKey(string value) {
        var parts=new List<string>();
        for(int i=0;i<value.Length;i++){int code=char.ConvertToUtf32(value,i);if(char.IsHighSurrogate(value[i]))i++;if(code!=0xfe0f)parts.Add(code.ToString("x",CultureInfo.InvariantCulture));}
        return string.Join("-",parts.ToArray());
    }
    Bitmap EmojiImage(string value) {
        Bitmap icon;if(emojiImages.TryGetValue(value,out icon))return icon;
        try{string path=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","app","public","emoji",EmojiKey(value)+".png");if(File.Exists(path))using(var source=new Bitmap(path))icon=new Bitmap(source);}
        catch(ArgumentException){}catch(IOException){}catch(UnauthorizedAccessException){}
        emojiImages[value]=icon;return icon;
    }
    void Avatar(Graphics g,string emoji,string color,float x,float y,float diameter,bool vivid) {
        Color fill=Color.FromArgb(77,83,73);
        if(color!=null&&System.Text.RegularExpressions.Regex.IsMatch(color,"^#[a-fA-F0-9]{6}$")) {
            var c=ColorTranslator.FromHtml(color);fill=vivid?c:Color.FromArgb((c.R+48)/2,(c.G+58)/2,(c.B+43)/2);
        }
        using(var brush=new SolidBrush(fill))g.FillEllipse(brush,x,y,diameter,diameter);
        var icon=string.IsNullOrEmpty(emoji)?null:EmojiImage(emoji);
        if(icon!=null){var saved=g.Save();g.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;float inset=diameter*.16f;g.DrawImage(icon,new RectangleF(x+inset,y+inset,diameter-2*inset,diameter-2*inset));g.Restore(saved);return;}
        // Custom emoji use the system emoji font rather than the Japanese private font.
        using(var font=new Font(string.IsNullOrEmpty(emoji)?Font.FontFamily.Name:"Segoe UI Emoji",diameter*.52f,FontStyle.Regular,GraphicsUnit.Pixel))
        using(var brush=new SolidBrush(Ink))using(var format=new StringFormat{Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center})g.DrawString(string.IsNullOrEmpty(emoji)?"?":emoji,font,brush,new RectangleF(x,y,diameter,diameter),format);
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);reportAreas.Clear();var g=e.Graphics;g.Clear(Background);
        g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        bool portrait=ClientSize.Height>ClientSize.Width;
        float scale=Math.Min(ClientSize.Width/(portrait?760f:1100f),ClientSize.Height/(portrait?1120f:720f));if(scale<=0)return;
        float width=ClientSize.Width/scale-72,height=ClientSize.Height/scale-72;
        int shift=(int)(elapsed.Elapsed.TotalSeconds/30);
        float dx=18+(shift*7%25),dy=18+(shift*11%25);
        g.ScaleTransform(scale,scale);g.TranslateTransform(dx,dy);paintScale=scale;paintDx=dx;paintDy=dy;
        bool vivid=usePresence&&presence.IsPresent;
        Color fg=vivid?Color.FromArgb(238,239,224):Ink;
        double age=data==null?double.MaxValue:elapsed.Elapsed.TotalSeconds-receivedAt;
        // Return hit target follows the exact same motion and DPI transform as its drawing.
        returnArea=new RectangleF((width-150+dx)*scale,dy*scale,150*scale,42*scale);
        // The same cards, labels and avatars morph between sparse and detailed layouts.
        {
            Box(g,new RectangleF(0,0,42,42),Color.FromArgb(53,64,43),Line,14);
            Write(g,"♨",29,Green,new RectangleF(6,0,38,44));
            Write(g,"ふろじゅん",25,fg,new RectangleF(54,0,200,44),true);
            Write(g,data==null?"今日の夜～":DateTime.Parse(data.day,CultureInfo.InvariantCulture).ToString("M月d日（ddd）",CultureInfo.GetCultureInfo("ja-JP"))+"の夜～",13,Muted,new RectangleF(2,51,360,25));
            Reveal(g,new RectangleF(width-150,0,150,42),delegate{
                Box(g,new RectangleF(width-150,0,150,42),Paper,Line,12);
                Write(g,"戻る  ·  Esc / F11",13,Muted,new RectangleF(width-135,10,130,26));
            });
            Divider(g,0,85,width);
        }
        float top=105,gap=20,left=width*.62f,right=width-left-gap;
        bool swap=(int)(elapsed.Elapsed.TotalMinutes/5)%2==1;
        float a=swap?right+gap:0,b=swap?0:left+gap;
        // A generous moving margin changes the whole card's location, including QR and clock.
        float driftX=(shift*19%37),driftY=(shift*13%33);
        float compactTop=105+driftY,compactHeight=height*.72f;
        DashboardEntry layoutCurrent,layoutNext,layoutAfter;PeopleAt(ServerNow,out layoutCurrent,out layoutNext,out layoutAfter);
        float detailHeight=PendingCompletion(ServerNow)!=null&&layoutCurrent!=null?280:232;
        var main=MixRect(new RectangleF(driftX,compactTop,left-36,compactHeight),new RectangleF(a,top,left,detailHeight),(float)transition);
        var share=MixRect(new RectangleF(left+gap,compactTop,right-36,compactHeight),new RectangleF(b,top,right,detailHeight),(float)transition);
        DrawPeople(g,main,fg,vivid,age);
        Box(g,share,Paper,Line);
        int qrSize=148;
        float qrY=share.Y+Mix(18,(detailHeight-qrSize)/2);
        DrawQr(g,share.X+18,qrY,qrSize,Muted);
        Write(g,"家族用リンク",Mix(19,15),Green,new RectangleF(share.X+182,qrY+50,share.Width-200,35),true);
        float chartHeight=Math.Max(0,share.Height-202)*(1-(float)transition);
        if(chartHeight>0) {
            var state=g.Save();g.SetClip(new RectangleF(share.X+12,share.Y+182,share.Width-24,chartHeight));
            DrawVerticalSchedule(g,new RectangleF(share.X+18,share.Y+182,share.Width-36,Math.Max(170,chartHeight)),fg,age);
            g.Restore(state);
        }
        DateTime utc=ServerNow;
        var clockRect=new RectangleF(width-430,-1,264,70);
        Write(g,utc.AddHours(9).ToString("HH:mm:ss"),Mix(48,34),fg,clockRect,true);
        float lists=main.Bottom+38,boxHeight=Math.Max(1,height-lists-44);
        float scheduleHeight=portrait?Math.Min(280,(boxHeight-18)/2):boxHeight;
        Reveal(g,new RectangleF(0,lists-24,width,boxHeight+24),delegate{
            Write(g,"入浴中・入浴済は予約時刻による表示です",11,Muted,new RectangleF(a+2,lists-29,left,24));
            DrawSchedule(g,new RectangleF(portrait?0:a,lists,portrait?width:left,scheduleHeight),fg);
            DrawMembers(g,portrait?new RectangleF(0,lists+scheduleHeight+18,width,boxHeight-scheduleHeight-18):new RectangleF(b,lists,right,boxHeight),fg,vivid);
        });
        if(transition<.99)return;
        string health=problem.Length>0?problem:data==null?"読み込み中…":age>20?"更新が途絶えています":data.phase=="ready"?"サーバー接続中":"サーバー準備中";
        using(var brush=new SolidBrush(age>20&&data!=null?Orange:Green))g.FillEllipse(brush,1,height-24,6,6);
        Write(g,health+"  ·  最終更新 "+(data==null?"—":serverTime.AddHours(9).ToString("HH:mm:ss")),11,Muted,new RectangleF(14,height-32,width*.59f,24));
        Write(g,usePresence?presence.Status:"",10,Muted,new RectangleF(width*.6f,height-32,width*.4f,24));
        if(!held)Write(g,"自動消灯を抑止できませんでした。Windowsの電源設定を確認してください。",12,Orange,new RectangleF(0,height-5,width,26));
    }
    void DrawSchedule(Graphics g,RectangleF rect,Color fg) {
        float a=rect.X,top=rect.Y,width=rect.Width,height=rect.Height;
        Box(g,rect,Paper,Line);
        Write(g,"スケジュール",18,fg,new RectangleF(a+24,top+17,width-48,32),true);
        Write(g,data==null?"":Time(data.bathStart)+" 〜 "+Time(data.bathEnd),12,Muted,new RectangleF(a+24,top+51,width-48,25));
        if(data==null)return;
        var entries=data.entries??new DashboardEntry[0];
        int rows=Math.Max(1,(int)((height-110)/53));
        int rangeStart=entries.Length==0?data.bathStart:int.MaxValue,rangeEnd=data.bathStart;
        foreach(var entry in entries){rangeStart=Math.Min(rangeStart,entry.start);rangeEnd=Math.Max(rangeEnd,entry.start+entry.duration);}
        float span=Math.Max(1,rangeEnd-rangeStart);
        Write(g,Time(rangeStart)+" → "+Time(rangeEnd),10,Muted,new RectangleF(a+width-208,top+51,190,24));
        int pages=Math.Max(1,(entries.Length+rows-1)/rows),page=(int)(elapsed.Elapsed.TotalSeconds/12)%pages;
        for(int i=page*rows;i<Math.Min(entries.Length,(page+1)*rows);i++) {
            var item=entries[i];float y=top+78+(i-page*rows)*53;bool wish=item.kind!="予約";
            bool conflict=item.overlaps!=null&&item.overlaps.Length>0;
            Box(g,new RectangleF(a+17,y,width-34,49),wish?Color.FromArgb(35,41,35):Color.FromArgb(42,52,36),conflict?Orange:wish?Color.FromArgb(85,99,74):Line,10,wish);
            Write(g,Time(item.start)+"–"+Time(item.start+item.duration),13,wish?Muted:Green,new RectangleF(a+28,y+3,148,25),true);
            Write(g,item.name,14,wish?Muted:fg,new RectangleF(a+177,y+2,width-295,25),true);
            Write(g,item.ticket=="guard"?"◇ ガード":item.ticket=="skip"?"↗ 順番抜かし":item.ticket=="extend"?"＋ 時間延長":conflict?"重なりあり":wish?"未確定":"予約済",11,conflict?Orange:wish?Muted:Green,new RectangleF(a+width-105,y+4,91,24));
            float trackX=a+28,trackWidth=width-56;
            using(var pen=new Pen(Line,1))g.DrawLine(pen,trackX,y+36,trackX+trackWidth,y+36);
            float barX=trackX+(item.start-rangeStart)/span*trackWidth,barWidth=item.duration/span*trackWidth;
            Box(g,new RectangleF(barX,y+29,Math.Max(2,barWidth),13),wish?Paper:Green,wish?Muted:Green,3,wish);
            if(conflict)foreach(var overlap in item.overlaps) {
                float x=trackX+(overlap.start-rangeStart)/span*trackWidth,w=(overlap.end-overlap.start)/span*trackWidth;
                using(var brush=new System.Drawing.Drawing2D.HatchBrush(System.Drawing.Drawing2D.HatchStyle.ForwardDiagonal,Orange,Paper))g.FillRectangle(brush,x,y+29,Math.Max(2,w),13);
            }
        }
        if(entries.Length==0)Write(g,"予約・希望はまだありません",16,Muted,new RectangleF(a+24,top+94,width-48,32));
        if(pages>1)Write(g,"全 "+entries.Length+" 件 · "+(page+1)+" / "+pages+"（自動切替）",11,Muted,new RectangleF(a+24,top+height-26,width-48,24));
    }
    void DrawMembers(Graphics g,RectangleF rect,Color fg,bool vivid) {
        float x=rect.X,top=rect.Y,width=rect.Width,height=rect.Height;
        Box(g,rect,Paper,Line);
        Write(g,"メンバー",18,fg,new RectangleF(x+22,top+17,width-44,32),true);
        if(data==null)return;
        var people=data.members??new DashboardMember[0];
        int count=Math.Max(1,(int)((height-88)/36));
        int total=Math.Max(1,(people.Length+count-1)/count),p=(int)(elapsed.Elapsed.TotalSeconds/12)%total;
        for(int i=p*count;i<Math.Min(people.Length,(p+1)*count);i++) {
            var person=people[i];float y=top+63+(i-p*count)*36;
            if(person.status=="入浴中")Box(g,new RectangleF(x+12,y-2,width-24,33),Color.FromArgb(48,62,38),Color.FromArgb(48,62,38),10);
            Avatar(g,person.emoji,person.color,x+22,y+1,28,vivid);
            Write(g,person.name,15,fg,new RectangleF(x+64,y+2,width-174,27),true);
            Write(g,person.deferred?person.status+"/様子見":person.status,11,person.status=="入浴中"?Green:Muted,new RectangleF(x+width-106,y+4,94,24));
            if(person.status!="入浴中")Divider(g,x+22,y+32,width-44);
        }
        if(people.Length==0)Write(g,"管理画面でメンバーを追加",13,Muted,new RectangleF(x+22,top+75,width-44,32));
        if(total>1)Write(g,(p+1)+" / "+total+"（自動切替）",11,Muted,new RectangleF(x+22,top+height-26,width-44,24));
    }
    DateTime ServerNow {get{return data==null?DateTime.UtcNow:serverTime.AddSeconds(elapsed.Elapsed.TotalSeconds-receivedAt);}}
    static int MinutesUntil(DateTime target,DateTime now){return (int)Math.Max(0,Math.Ceiling((target-now).TotalMinutes));}
    static DateTime Instant(string value){return DateTime.Parse(value,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal|DateTimeStyles.AssumeUniversal);}
    void PeopleAt(DateTime now,out DashboardEntry current,out DashboardEntry next,out DashboardEntry afterNext) {
        current=null;next=null;afterNext=null;
        if(data==null)return;
        var confirmed=new List<DashboardEntry>();foreach(var entry in data.entries??new DashboardEntry[0])if(entry.kind=="予約")confirmed.Add(entry);
        confirmed.Sort((a,b)=>a.start.CompareTo(b.start));
        foreach(var entry in confirmed){if(entry.completedAt==null&&Instant(entry.startsAt)<=now&&now<Instant(entry.endsAt))current=entry;else if(Instant(entry.startsAt)>now){if(next==null)next=entry;else if(afterNext==null)afterNext=entry;}}
    }
    DashboardEntry PendingCompletion(DateTime now) {
        DashboardEntry result=null;foreach(var entry in data==null?new DashboardEntry[0]:data.entries??new DashboardEntry[0])if(entry.kind=="予約"&&entry.completedAt==null&&entry.revision!=null&&Instant(entry.endsAt)<=now&&now<=Instant(entry.endsAt).AddSeconds(60))if(result==null||entry.start>result.start)result=entry;return result;
    }
    void ReportButton(Graphics g,DashboardEntry entry,RectangleF rect) {
        if(Report==null||entry==null||entry.revision==null||entry.completedAt!=null)return;
        Box(g,rect,Color.FromArgb(66,85,49),Green,10);Write(g,reportBusy?"送信中…":"完了を報告",14,Ink,new RectangleF(rect.X+10,rect.Y+10,rect.Width-16,28),true);
        reportAreas.Add(new KeyValuePair<RectangleF,DashboardEntry>(new RectangleF((rect.X+paintDx)*paintScale,(rect.Y+paintDy)*paintScale,rect.Width*paintScale,rect.Height*paintScale),entry));
    }
    static string CountdownText(int minutes){return minutes<60?minutes+"分":minutes/60+"時間"+(minutes%60==0?"":minutes%60+"分");}
    string[] RemainingParts(DashboardEntry entry,DateTime now) {
        int minutes=MinutesUntil(Instant(entry.endsAt),now);string suffix=" | 〜"+Time(entry.start+entry.duration);
        if(minutes<60)return new[]{"あと ",minutes.ToString(CultureInfo.InvariantCulture)," 分"+suffix};
        if(minutes%60==0)return new[]{"あと ",(minutes/60).ToString(CultureInfo.InvariantCulture)," 時間"+suffix};
        return new[]{"あと ",(minutes/60).ToString(CultureInfo.InvariantCulture)," 時間 ",(minutes%60).ToString(CultureInfo.InvariantCulture)," 分"+suffix};
    }
    string UpcomingTime(DashboardEntry entry,DateTime now){return CountdownText(MinutesUntil(Instant(entry.startsAt),now))+"後 | "+Time(entry.start)+" 〜 "+Time(entry.start+entry.duration);}
    float RemainingWidth(Graphics g,DashboardEntry entry,DateTime now,float small,float large) {
        string[] parts=RemainingParts(entry,now);float width=0;
        for(int i=0;i<parts.Length;i++)width+=g.MeasureString(parts[i],TextFont(i%2==1?large:small,true),int.MaxValue,StringFormat.GenericTypographic).Width+2;
        return width;
    }
    bool RemainingFits(Graphics g,DashboardEntry entry,DateTime now,float width,out float nameWidth) {
        nameWidth=g.MeasureString(entry.name??"",TextFont(29,true),int.MaxValue,StringFormat.GenericTypographic).Width+8;
        return 42+18+nameWidth+20+RemainingWidth(g,entry,now,15,29)+8<=width;
    }
    float Baseline(float size){return size*Font.FontFamily.GetCellAscent(FontStyle.Bold)/Font.FontFamily.GetEmHeight(FontStyle.Bold);}
    void DrawRemaining(Graphics g,DashboardEntry entry,DateTime now,float x,float y,float width) {
        float small=Mix(24,15),large=Mix(80,29),height=Mix(106,40);
        string[] parts=RemainingParts(entry,now);float cursor=x;
        for(int i=0;i<parts.Length;i++) {
            float size=i%2==1?large:small;
            float measured=g.MeasureString(parts[i],TextFont(size,true),int.MaxValue,StringFormat.GenericTypographic).Width+2;
            Write(g,parts[i],size,Green,new RectangleF(cursor,y+Baseline(large)-Baseline(size),Math.Max(0,width-(cursor-x)),height),true);cursor+=measured;
        }
    }
    void DrawPeople(Graphics g,RectangleF rect,Color fg,bool vivid,double age) {
        Box(g,rect,Paper,Line);
        DateTime now=ServerNow;DashboardEntry current,next,afterNext;PeopleAt(now,out current,out next,out afterNext);
        var pending=PendingCompletion(now);var first=pending??current??next;var second=pending!=null?(current??next):current!=null?next:afterNext;
        float x=rect.X+24,w=rect.Width-48,y=rect.Y;
        bool canReport=age<=20&&first!=null&&(pending!=null||current!=null);
        Write(g,pending!=null?"入浴完了":current!=null?"入浴中":"次にお風呂に入る人",Mix(24,16),Green,new RectangleF(x,y+18,canReport?w-168:w,36),true);
        float avatarSize=Mix(68,42),nameX=x+avatarSize+18;
        if(first!=null&&age<=20)Avatar(g,first.emoji,first.color,x,y+Mix(67,64),avatarSize,vivid);
        Write(g,age>20?"更新待ち":first==null?"次の予約はありません":first.name,Mix(62,29),fg,new RectangleF(first==null?x:nameX,y+Mix(59,57),first==null?w:w-avatarSize-18,Mix(94,46)),true);
        if(age<=20&&first!=null) {
            if(pending!=null)Write(g,"完了報告をお願いします",Mix(24,16),Green,new RectangleF(x,y+Mix(180,108),w,Mix(64,38)),true);
            else if(current!=null){
                float nameWidth;bool inline=RemainingFits(g,first,now,w,out nameWidth);
                var countdown=MixRect(new RectangleF(x,y+145,w,106),inline?new RectangleF(x+60+nameWidth+20,y+57,w-60-nameWidth-20,40):new RectangleF(x,y+104,w,40),(float)transition);
                DrawRemaining(g,first,now,countdown.X,countdown.Y,countdown.Width);
            }
            else Write(g,UpcomingTime(first,now),Mix(31,18),Green,new RectangleF(x,y+Mix(185,110),w,Mix(70,36)),true);
        }
        float divider=y+Mix(270,150);Divider(g,x,divider,w);
        if(canReport)ReportButton(g,first,new RectangleF(x+w-154,y+14,154,44));
        Write(g,pending!=null&&current!=null?"入浴中":pending!=null||current!=null?"次に入る人":"その次に入る人",Mix(22,12),Green,new RectangleF(x,divider+Mix(23,10),w,34),true);
        var secondName=MixRect(new RectangleF(x,divider+65,w,70),new RectangleF(x,divider+37,Math.Min(150,w*.3f),30),(float)transition);
        var secondTime=MixRect(new RectangleF(x,divider+137,w,58),new RectangleF(x+Math.Min(150,w*.3f)+18,divider+37,w-Math.Min(150,w*.3f)-18,30),(float)transition);
        Write(g,age>20?"更新待ち":second==null?"次の予約はありません":second.name,Mix(44,17),fg,secondName,true);
        Write(g,age>20||second==null?"":pending!=null&&second==current?"あと "+CountdownText(MinutesUntil(Instant(current.endsAt),now))+" | 〜"+Time(current.start+current.duration):UpcomingTime(second,now),Mix(31,18),Green,secondTime,true);
        if(age<=20&&pending!=null&&current!=null)ReportButton(g,current,new RectangleF(x+w-154,divider+Mix(16,76),154,44));
    }
    sealed class ChartPart {public int start,end;public double weight;}
    static float ChartY(int minute,List<ChartPart> parts,float top,float height) {
        double total=0,position=0;foreach(var part in parts)total+=part.weight;
        foreach(var part in parts){if(minute>=part.end)position+=part.weight;else if(minute>part.start){position+=(minute-part.start)/(double)(part.end-part.start)*part.weight;break;}else break;}
        return top+(float)(position/Math.Max(1,total))*height;
    }
    void DrawVerticalSchedule(Graphics g,RectangleF rect,Color fg,double age) {
        Write(g,"スケジュール",16,fg,new RectangleF(rect.X,rect.Y,rect.Width,30),true);
        if(data==null||age>20){Write(g,"更新待ち",13,Muted,new RectangleF(rect.X,rect.Y+42,rect.Width,28));return;}
        var entries=new List<DashboardEntry>(data.entries??new DashboardEntry[0]);entries.Sort((a,b)=>a.start.CompareTo(b.start));
        if(entries.Count==0){Write(g,"予約・希望はまだありません",12,Muted,new RectangleF(rect.X,rect.Y+42,rect.Width,28));return;}
        var parts=new List<ChartPart>();int end=entries[0].start;
        foreach(var entry in entries){if(entry.start>end){parts.Add(new ChartPart{start=end,end=entry.start,weight=Math.Min(entry.start-end,60)});end=entry.start;}
            int to=entry.start+entry.duration;if(to>end){parts.Add(new ChartPart{start=end,end=to,weight=to-end});end=to;}}
        var laneEnds=new List<int>();var lanes=new List<int>();foreach(var entry in entries){int lane=0;while(lane<laneEnds.Count&&laneEnds[lane]>entry.start)lane++;if(lane==laneEnds.Count)laneEnds.Add(0);laneEnds[lane]=entry.start+entry.duration;lanes.Add(lane);}
        float chartTop=rect.Y+43,chartHeight=Math.Max(1,rect.Height-64),trackX=rect.X+70,trackWidth=rect.Width-70,laneWidth=trackWidth/Math.Max(1,laneEnds.Count);
        var ticks=new SortedSet<int>();foreach(var entry in entries){ticks.Add(entry.start);ticks.Add(entry.start+entry.duration);}
        float last=-100;foreach(int tick in ticks){float lineY=ChartY(tick,parts,chartTop,chartHeight);if(lineY-last>=16){Write(g,Time(tick),11,Muted,new RectangleF(rect.X,lineY-8,68,22));last=lineY;using(var pen=new Pen(Line,1))g.DrawLine(pen,trackX,lineY,rect.Right,lineY);}}
        for(int i=0;i<entries.Count;i++) {
            var entry=entries[i];float y=ChartY(entry.start,parts,chartTop,chartHeight),bottom=ChartY(entry.start+entry.duration,parts,chartTop,chartHeight);
            bool wish=entry.kind!="予約",conflict=entry.overlaps!=null&&entry.overlaps.Length>0;float x=trackX+lanes[i]*laneWidth;
            var bar=new RectangleF(x+2,y+1,Math.Max(1,laneWidth-4),Math.Max(3,bottom-y-2));
            Box(g,bar,wish?Paper:Color.FromArgb(48,62,38),conflict?Orange:Green,4,wish);
            if(conflict)foreach(var overlap in entry.overlaps){float a=ChartY(overlap.start,parts,chartTop,chartHeight),b=ChartY(overlap.end,parts,chartTop,chartHeight);using(var brush=new System.Drawing.Drawing2D.HatchBrush(System.Drawing.Drawing2D.HatchStyle.ForwardDiagonal,Orange,Color.Transparent))g.FillRectangle(brush,bar.X,a,bar.Width,Math.Max(1,b-a));}
            if(bar.Height>=18)Write(g,(entry.ticket=="guard"?"◇ ":entry.ticket=="skip"?"↗ ":entry.ticket=="extend"?"＋ ":"")+entry.name,11,wish?Muted:Green,new RectangleF(bar.X+4,bar.Y+2,Math.Max(1,bar.Width-8),22),true);
        }
        foreach(var part in parts)if(part.end-part.start>=120&&part.weight==60){float y=ChartY((part.start+part.end)/2,parts,chartTop,chartHeight);Write(g,"〜",16,Muted,new RectangleF(trackX,y-10,trackWidth,24));}
    }
    void DrawQr(Graphics g,float x,float y,int size,Color fg) {
        var matrix=data==null?null:data.qr;
        if(matrix==null||matrix.Length==0||data.phase!="ready"||elapsed.Elapsed.TotalSeconds-receivedAt>20) {
            Write(g,"公開用リンクの準備後に",11,fg,new RectangleF(x-20,y+44,size+40,28));
            Write(g,"共有QRを表示します",11,fg,new RectangleF(x-12,y+70,size+24,28));return;
        }
        // Paint QR modules on integer physical pixels; do not antialias the code.
        var saved=g.Save();g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.None;
        int n=matrix.Length;float[] transform;using(var matrixTransform=g.Transform)transform=matrixTransform.Elements;float scale=transform[0];
        int unit=Math.Max(1,(int)(size*scale/(n+8))),actual=unit*(n+8);
        float px=(float)Math.Round(x*scale+transform[4]),py=(float)Math.Round(y*scale+transform[5]);
        g.ResetTransform();
        using(var light=new SolidBrush(Color.FromArgb(211,217,201)))g.FillRectangle(light,px,py,actual,actual);
        using(var dark=new SolidBrush(Background))for(int row=0;row<n;row++)for(int col=0;col<n;col++)if(matrix[row][col]=='1')g.FillRectangle(dark,px+(col+4)*unit,py+(row+4)*unit,unit,unit);
        g.Restore(saved);

    }
}
