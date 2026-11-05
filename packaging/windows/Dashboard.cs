using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

public sealed class DashboardEntry { public int memberId,start,duration; public string name,kind,startsAt,endsAt,emoji,color; }
public sealed class DashboardMember { public int id; public string name,status,emoji,color; public bool deferred; }
public sealed class DashboardData {
    public string day,now,phase,shareUrl; public int bathStart,bathEnd;
    public DashboardEntry current,next; public DashboardEntry[] entries; public DashboardMember[] members; public string[] qr;
}
// Single native surface: no embedded browser or camera stream. All drawn content,
// including the QR quiet zone, moves periodically inside a safe margin.
internal sealed class DashboardForm : Form {
    readonly Action request;
    readonly bool usePresence;
    readonly PowerLease display=new PowerLease();
    readonly System.Windows.Forms.Timer clock=new System.Windows.Forms.Timer{Interval=1000};
    readonly Stopwatch elapsed=Stopwatch.StartNew();
    readonly HumanPresenceReader presence=new HumanPresenceReader();
    DashboardData data; double receivedAt; DateTime serverTime;
    readonly Dictionary<string,Font> textFonts=new Dictionary<string,Font>();
    bool disposed;
    bool held,waiting; double requestedAt; string problem="";
    public DashboardForm(Action request,bool usePresence):this(request,usePresence,Typeface()) {}
    public DashboardForm(Action request,bool usePresence,FontFamily typeface) {
        this.request=request;this.usePresence=usePresence;
        AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        Text="ふろじゅん";FormBorderStyle=FormBorderStyle.None;WindowState=FormWindowState.Maximized;
        BackColor=Background;ForeColor=Ink;DoubleBuffered=true;KeyPreview=true;
        Font=new Font(typeface,12,FontStyle.Regular);
        KeyDown+=delegate(object sender,KeyEventArgs e){if(e.KeyCode==Keys.Escape||e.KeyCode==Keys.F11)Close();};
        // Touch users can leave the dashboard without a keyboard.
        MouseDown+=delegate(object sender,MouseEventArgs e){if(returnArea.Contains(e.Location))Close();};
        Shown+=delegate{held=display.Acquire(true);if(usePresence)presence.Start();Poll();clock.Start();};
        clock.Tick+=delegate{
            if(!held)held=display.Acquire(true);
            if(!waiting&&elapsed.Elapsed.TotalSeconds-requestedAt>=5)Poll();
            if(waiting&&elapsed.Elapsed.TotalSeconds-requestedAt>15){waiting=false;problem="更新が途絶えています";}
            Invalidate();
        };

    }
    protected override void Dispose(bool disposing) {
        if(disposing&&!disposed){disposed=true;clock.Stop();clock.Dispose();presence.Dispose();display.Dispose();foreach(var font in textFonts.Values)font.Dispose();textFonts.Clear();}
        base.Dispose(disposing);
    }
    Font TextFont(float size,bool bold) {
        string key=size.ToString(CultureInfo.InvariantCulture)+(bold?"b":"r");Font value;
        if(!textFonts.TryGetValue(key,out value)){value=new Font(Font.FontFamily,size,bold?FontStyle.Bold:FontStyle.Regular,GraphicsUnit.Pixel);textFonts.Add(key,value);}
        return value;
    }
    void Poll(){waiting=true;requestedAt=elapsed.Elapsed.TotalSeconds;request();}
    public void UpdateData(DashboardData value){data=value;serverTime=DateTime.Parse(value.now,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal|DateTimeStyles.AssumeUniversal);receivedAt=elapsed.Elapsed.TotalSeconds;waiting=false;problem="";Invalidate();}
    public void Fail(string message){waiting=false;problem=message;Invalidate();}
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
    void Avatar(Graphics g,string emoji,string color,float x,float y,float diameter,bool vivid) {
        Color fill=Color.FromArgb(77,83,73);
        if(color!=null&&System.Text.RegularExpressions.Regex.IsMatch(color,"^#[a-fA-F0-9]{6}$")) {
            var c=ColorTranslator.FromHtml(color);fill=vivid?c:Color.FromArgb((c.R+48)/2,(c.G+58)/2,(c.B+43)/2);
        }
        using(var brush=new SolidBrush(fill))g.FillEllipse(brush,x,y,diameter,diameter);
        using(var font=new Font(Font.FontFamily,diameter*.45f,FontStyle.Regular,GraphicsUnit.Pixel))
        using(var brush=new SolidBrush(Ink))using(var format=new StringFormat{Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center})g.DrawString(string.IsNullOrEmpty(emoji)?"?":emoji,font,brush,new RectangleF(x,y,diameter,diameter),format);
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);var g=e.Graphics;g.Clear(Background);
        g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        bool portrait=ClientSize.Height>ClientSize.Width;
        float scale=Math.Min(ClientSize.Width/(portrait?760f:1100f),ClientSize.Height/(portrait?1120f:720f));if(scale<=0)return;
        float width=ClientSize.Width/scale-72,height=ClientSize.Height/scale-72;
        int shift=(int)(elapsed.Elapsed.TotalSeconds/30);
        float dx=18+(shift*7%25),dy=18+(shift*11%25);
        g.ScaleTransform(scale,scale);g.TranslateTransform(dx,dy);
        bool absent=usePresence&&presence.NotPresent,vivid=usePresence&&presence.IsPresent;
        Color fg=vivid?Color.FromArgb(238,239,224):Ink;
        double age=data==null?double.MaxValue:elapsed.Elapsed.TotalSeconds-receivedAt;
        // Return hit target follows the exact same motion and DPI transform as its drawing.
        returnArea=new RectangleF((width-150+dx)*scale,dy*scale,150*scale,42*scale);
        if(absent){DrawDistant(g,width,height,shift,age);return;}
        Box(g,new RectangleF(0,0,42,42),Color.FromArgb(53,64,43),Line,14);
        Write(g,"♨",29,Green,new RectangleF(6,0,38,44));
        Write(g,"ふろじゅん",25,fg,new RectangleF(54,0,200,44),true);
        using(var brush=new SolidBrush(Orange))g.FillEllipse(brush,198,26,5,5);
        Write(g,data==null?"今日の夜～":DateTime.Parse(data.day,CultureInfo.InvariantCulture).ToString("M月d日（ddd）",CultureInfo.GetCultureInfo("ja-JP"))+"の夜～",13,Muted,new RectangleF(2,51,360,25));
        DateTime utc=data==null?DateTime.UtcNow:serverTime.AddSeconds(elapsed.Elapsed.TotalSeconds-receivedAt);
        Write(g,utc.AddHours(9).ToString("HH:mm:ss"),34,fg,new RectangleF(width-430,-1,264,47),true);
        Write(g,"日本時間",11,Muted,new RectangleF(width-425,49,260,24));
        Box(g,new RectangleF(width-150,0,150,42),Paper,Line,12);
        Write(g,"戻る  ·  Esc / F11",13,Muted,new RectangleF(width-135,10,130,26));
        Divider(g,0,86,width);
        float top=105,gap=20,left=width*.62f,right=width-left-gap;
        bool swap=(int)(elapsed.Elapsed.TotalMinutes/5)%2==1;
        float a=swap?right+gap:0,b=swap?0:left+gap;
        Box(g,new RectangleF(a,top,left,190),Paper,Line);
        Write(g,"次にお風呂に入る人",16,Green,new RectangleF(a+24,top+19,left-48,30),true);
        var next=data==null?null:data.next;
        if(next!=null&&age<=20) {
            Avatar(g,next.emoji,next.color,a+24,top+50,50,vivid);
            Write(g,next.name,31,fg,new RectangleF(a+90,top+48,left-114,45),true);
            Badge(g,Time(next.start)+" 〜 "+Time(next.start+next.duration),new RectangleF(a+90,top+99,190,28),Green,Color.FromArgb(48,62,38));
        }else Write(g,age>20&&data!=null?"更新待ち":data==null?"読み込み中…":"次の予約はありません",24,fg,new RectangleF(a+24,top+67,left-48,53),true);
        Divider(g,a+24,top+137,left-48);
        var current=data==null?null:data.current;
        Write(g,"入浴中",12,Green,new RectangleF(a+24,top+155,66,28),true);
        Write(g,age>20&&data!=null?"更新待ち":current==null?"現在の予約はありません":current.name+"   〜 "+Time(current.start+current.duration),17,fg,new RectangleF(a+96,top+151,left-120,34),true);
        Box(g,new RectangleF(b,top,right,190),Paper,Line);
        Write(g,"家族用リンク",15,Green,new RectangleF(b+20,top+16,right-40,30),true);
        DrawQr(g,b+(right-148)/2,top+42,148,Muted);
        Write(g,"家族内で共有",10,Muted,new RectangleF(b+right-105,top+21,90,23));
        Write(g,"入浴中・入浴済は予約時刻による表示です",11,Muted,new RectangleF(a+2,top+199,left,24));
        float lists=top+228,boxHeight=height-lists-44;
        float scheduleHeight=portrait?Math.Min(280,(boxHeight-18)/2):boxHeight;
        DrawSchedule(g,new RectangleF(portrait?0:a,lists,portrait?width:left,scheduleHeight),fg);
        DrawMembers(g,portrait?new RectangleF(0,lists+scheduleHeight+18,width,boxHeight-scheduleHeight-18):new RectangleF(b,lists,right,boxHeight),fg,vivid);
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
        int rows=Math.Max(1,(int)((height-96)/34));
        int pages=Math.Max(1,(entries.Length+rows-1)/rows),page=(int)(elapsed.Elapsed.TotalSeconds/12)%pages;
        for(int i=page*rows;i<Math.Min(entries.Length,(page+1)*rows);i++) {
            var item=entries[i];float y=top+78+(i-page*rows)*34;bool wish=item.kind!="予約";
            Box(g,new RectangleF(a+17,y,width-34,31),wish?Color.FromArgb(35,41,35):Color.FromArgb(42,52,36),wish?Color.FromArgb(85,99,74):Color.FromArgb(60,74,48),10,wish);
            Write(g,Time(item.start)+"–"+Time(item.start+item.duration),14,wish?Muted:Green,new RectangleF(a+28,y+5,153,26),true);
            Write(g,item.name,15,wish?Muted:fg,new RectangleF(a+185,y+4,width-282,25),true);
            Write(g,wish?"未確定":"予約済",11,wish?Muted:Green,new RectangleF(a+width-78,y+6,65,24));
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
    void DrawDistant(Graphics g,float width,float height,int shift,double age) {
        float top=height*.29f+(shift%5)*9;
        Write(g,"次にお風呂に入る人",25,Muted,new RectangleF(24,top-62,width-48,45));
        string name=age>20?"更新待ち":data.next==null?"次の予約はありません":data.next.name;
        Write(g,name,72,Ink,new RectangleF(24,top,width-48,115),true);
        Write(g,age>20||data.next==null?"":Time(data.next.start)+" 〜",94,Green,new RectangleF(24,top+126,width-48,150),true);
        Write(g,"戻る  ·  Esc",13,Muted,new RectangleF(width-134,10,134,26));
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
