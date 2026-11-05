using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Windows.Forms;
// Render without showing the form: no power requests, sensor access or live IPC.
internal static class DashboardTest {
    static void Set(object target,string name,object value){target.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).SetValue(target,value);}
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        var type=typeof(DashboardData).Assembly.GetType("DashboardForm");
        var data=new JavaScriptSerializer().Deserialize<DashboardData>(File.ReadAllText(args[0]));
        foreach(var size in new[]{new Size(1280,800),new Size(800,1280),new Size(1920,1080)}) {
            foreach(bool absent in new[]{false,true}) {
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
                    type.GetMethod("UpdateData").Invoke(form,new object[]{data});Set(form,"held",true);
                    var reader=type.GetField("presence",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);
                    Set(reader,"absent",absent);Set(reader,"present",!absent);
                    using(var bitmap=new Bitmap(size.Width,size.Height)){form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,size));bitmap.Save(Path.Combine(args[1],"dashboard-"+size.Width+"x"+size.Height+(absent?"-away":"")+".png"));}
                }finally{form.Dispose();}
            }
        }
        Console.WriteLine("Dashboard rendered at 1280x800, 800x1280 and 1920x1080, with detailed and distant views.");
    }
}
