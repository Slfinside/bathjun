using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

public sealed class DashboardEntry { public int memberId,start,duration; public string name,kind,startsAt,endsAt; }
public sealed class DashboardMember { public int id; public string name,status; public bool deferred; }
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
    bool held,waiting; double requestedAt; string problem="";
    public DashboardForm(Action request,bool usePresence) {
        this.request=request;this.usePresence=usePresence;
        AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        Text="ふろじゅん";FormBorderStyle=FormBorderStyle.None;WindowState=FormWindowState.Maximized;
        BackColor=Color.FromArgb(9,13,17);ForeColor=Color.FromArgb(174,188,192);DoubleBuffered=true;KeyPreview=true;
        Font=new Font("Yu Gothic UI",12);
        KeyDown+=delegate(object sender,KeyEventArgs e){if(e.KeyCode==Keys.Escape||e.KeyCode==Keys.F11)Close();};
        // Touch users can leave the dashboard without a keyboard.
        MouseDown+=delegate(object sender,MouseEventArgs e){if(e.Y<60&&e.X>ClientSize.Width-180)Close();};
        Shown+=delegate{held=display.Acquire(true);if(usePresence)presence.Start();Poll();clock.Start();};
        clock.Tick+=delegate{
            if(!held)held=display.Acquire(true);
            if(!waiting&&elapsed.Elapsed.TotalSeconds-requestedAt>=5)Poll();
            if(waiting&&elapsed.Elapsed.TotalSeconds-requestedAt>15){waiting=false;problem="更新が途絶えています";}
            Invalidate();
        };
        FormClosed+=delegate{clock.Stop();clock.Dispose();presence.Dispose();display.Dispose();};
    }
    void Poll(){waiting=true;requestedAt=elapsed.Elapsed.TotalSeconds;request();}
    public void UpdateData(DashboardData value){data=value;serverTime=DateTime.Parse(value.now,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal|DateTimeStyles.AssumeUniversal);receivedAt=elapsed.Elapsed.TotalSeconds;waiting=false;problem="";Invalidate();}
    public void Fail(string message){waiting=false;problem=message;Invalidate();}
    static string Time(int minute){return (minute>=1440?"翌":"")+(minute/60%24).ToString("00")+":"+(minute%60).ToString("00");}
    void Write(Graphics g,string text,float size,Color color,RectangleF rect,bool bold=false) {
        using(var font=new Font(Font.FontFamily,size, bold?FontStyle.Bold:FontStyle.Regular,GraphicsUnit.Pixel))
        using(var brush=new SolidBrush(color))
        using(var format=new StringFormat{Trimming=StringTrimming.EllipsisCharacter,FormatFlags=StringFormatFlags.NoWrap})g.DrawString(text??"",font,brush,rect,format);
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);var g=e.Graphics;
        // Work in a virtual coordinate space for portrait, landscape, and DPI scaling.
        float scale=Math.Min(ClientSize.Width/1100f,ClientSize.Height/720f);
        if(scale<=0)return;
        float width=ClientSize.Width/scale,height=ClientSize.Height/scale;
        g.ScaleTransform(scale,scale);
        int shift=(int)(elapsed.Elapsed.TotalSeconds/30);
        float dx=12+(shift*7%25),dy=12+(shift*11%25);
        g.TranslateTransform(dx,dy);width-=60;height-=60;
        bool absent=usePresence&&presence.NotPresent;
        Color fg=usePresence&&presence.IsPresent?Color.FromArgb(225,233,234):Color.FromArgb(174,188,192);
        double freshness=data==null?double.MaxValue:elapsed.Elapsed.TotalSeconds-receivedAt;
        if(absent) {
            float top=height*.30f+(shift%5)*9;
            Write(g,"次にお風呂に入る人",30,Color.FromArgb(112,145,140),new RectangleF(20,top-55,width-40,50));
            string name=freshness>20?"更新待ち":data.next==null?"次の予約はありません":data.next.name;
            Write(g,name,76,Color.FromArgb(156,170,171),new RectangleF(20,top,width-40,115),true);
            Write(g,freshness>20||data.next==null?"":Time(data.next.start)+" ～",102,Color.FromArgb(150,174,170),new RectangleF(20,top+122,width-40,145),true);
            Write(g,"戻る · 右上をタップ / Esc",14,Color.FromArgb(85,99,100),new RectangleF(width-245,0,245,30));
            return;
        }
        Color accent=absent?Color.FromArgb(77,111,108):Color.FromArgb(122,180,170);
        Write(g,"ふろじゅん",24,accent,new RectangleF(0,0,width-180,40),true);
        Write(g,"戻る · Esc / F11",15,fg,new RectangleF(width-155,0,155,32));
        DateTime utc=data==null?DateTime.UtcNow:serverTime.AddSeconds(elapsed.Elapsed.TotalSeconds-receivedAt);
        Write(g,utc.AddHours(9).ToString("MM/dd（ddd） HH:mm:ss",CultureInfo.GetCultureInfo("ja-JP")),38,fg,new RectangleF(0,42,width-260,55),true);
        double age=data==null?double.MaxValue:elapsed.Elapsed.TotalSeconds-receivedAt;
        string health=problem.Length>0?problem:age>20?"更新が途絶えています":data==null?"読み込み中…":data.phase=="ready"?"● サーバー接続中":"サーバー準備中";
        Write(g,health,16,age>20?Color.FromArgb(185,125,105):accent,new RectangleF(0,100,width-260,28));
        Write(g,"最終更新 "+(data==null?"—":serverTime.AddHours(9).ToString("HH:mm:ss"))+"  日本時間",14,fg,new RectangleF(0,128,width-260,24));
        if(!held)Write(g,"自動消灯の抑止に失敗：Windowsの電源設定を確認してください",14,Color.Salmon,new RectangleF(0,152,width-260,24));
        DrawQr(g,width-215,42,188,fg);
        float y=202,left=width*.59f,right=width-left-30;
        bool swap=(int)(elapsed.Elapsed.TotalMinutes/5)%2==1;
        float a=swap?right+30:0,b=swap?0:left+30;
        Write(g,"次にお風呂に入る人",19,accent,new RectangleF(a,y,left,30));
        Write(g,age>20?"更新待ち":data==null||data.next==null?"次の予約はありません":data.next.name+"  "+Time(data.next.start),30,fg,new RectangleF(a,y+34,left,44),true);
        Write(g,"今入っている人（予約時刻による表示）",17,accent,new RectangleF(a,y+85,left,28));
        Write(g,age>20?"更新待ち":data==null||data.current==null?"現在の予約はありません":data.current.name+"  ～ "+Time(data.current.start+data.current.duration),24,fg,new RectangleF(a,y+117,left,38),true);
        float listY=y+173;
        Write(g,"スケジュール  "+(data==null?"":data.day+" の夜～"),19,accent,new RectangleF(a,listY,left,30));
        if(data!=null) {
            Write(g,Time(data.bathStart)+" ～ "+Time(data.bathEnd)+"  · 希望は未確定",14,fg,new RectangleF(a,listY+30,left,24));
            var entries=data.entries??new DashboardEntry[0];
            int rows=Math.Max(1,(int)((height-listY-100)/34));
            int pages=Math.Max(1,(entries.Length+rows-1)/rows),page=(int)(elapsed.Elapsed.TotalSeconds/12)%pages;
            for(int i=page*rows;i<Math.Min(entries.Length,(page+1)*rows);i++) {
                var item=entries[i];float rowY=listY+60+(i-page*rows)*34;
                Write(g,Time(item.start)+"–"+Time(item.start+item.duration),17,fg,new RectangleF(a,rowY,165,32));
                Write(g,item.name+"  "+item.kind,17,item.kind=="予約"?fg:Color.FromArgb(110,129,145),new RectangleF(a+165,rowY,left-165,32));
            }
            if(entries.Length==0)Write(g,"予約・希望はまだありません",18,fg,new RectangleF(a,listY+62,left,32));
            if(pages>1)Write(g,"全 "+entries.Length+" 件 · "+(page+1)+" / "+pages+"（自動切替）",14,fg,new RectangleF(a,height-35,left,25));
            var people=data.members??new DashboardMember[0];
            Write(g,"メンバー",20,accent,new RectangleF(b,y,right,32),true);
            int count=Math.Max(1,(int)((height-y-100)/45));
            int total=Math.Max(1,(people.Length+count-1)/count),p=(int)(elapsed.Elapsed.TotalSeconds/12)%total;
            for(int i=p*count;i<Math.Min(people.Length,(p+1)*count);i++) {
                var person=people[i];float rowY=y+46+(i-p*count)*45;
                Write(g,person.name,20,fg,new RectangleF(b,rowY,right*.53f,36));
                Write(g,person.status+(person.deferred?" · 様子見":""),17,person.status=="入浴中"?accent:fg,new RectangleF(b+right*.53f,rowY,right*.47f,36));
            }
            if(people.Length==0)Write(g,"管理画面でメンバーを追加してください",16,fg,new RectangleF(b,y+48,right,32));
            if(total>1)Write(g,(p+1)+" / "+total+"（自動切替）",14,fg,new RectangleF(b,height-35,right,25));
        }
        string sensor=!usePresence?"":presence.Status;
        Write(g,sensor,13,fg,new RectangleF(0,height+5,width,24));
    }
    void DrawQr(Graphics g,float x,float y,int size,Color fg) {
        var matrix=data==null?null:data.qr;
        // Never show a stale or local-only code as a usable external link.
        if(matrix==null||matrix.Length==0||data.phase!="ready"||elapsed.Elapsed.TotalSeconds-receivedAt>20) {
            Write(g,"外部公開が有効になると\n共有QRを表示します",16,fg,new RectangleF(x,y,size,90));return;
        }
        int n=matrix.Length,unit=Math.Max(1,size/(n+8)),actual=unit*(n+8);
        using(var light=new SolidBrush(Color.FromArgb(190,198,195)))g.FillRectangle(light,x,y,actual,actual);
        using(var dark=new SolidBrush(Color.FromArgb(13,20,22)))for(int row=0;row<n;row++)for(int col=0;col<n;col++)if(matrix[row][col]=='1')g.FillRectangle(dark,x+(col+4)*unit,y+(row+4)*unit,unit,unit);
        Write(g,"家族用リンク · 取扱注意",13,fg,new RectangleF(x,y+actual+5,size+20,24));
    }
}
