using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
// Run in an isolated graphical test session; the form is never shown, so no power request or IPC is started.
internal static class MemberEntryTest {
    static void Check(bool value,string message){if(!value)throw new Exception(message);}
    static object Field(Form form,string name){return form.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);}
    static void Set(Form form,string name,object value){form.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).SetValue(form,value);}
    static object Call(Form form,string name,params object[] values){return form.GetType().GetMethod(name,BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,values);}
    static Schedule Rule(){return new Schedule{bookingCutoff=420,lotteryStart=360,lotteryEnd=900,minDuration=15,maxDuration=90,step=15,orderMode="random",fixedOrder=new int[0]};}
    static Form Create(Member[] members){var type=typeof(Member).Assembly.GetType("PanelForm");var form=(Form)Activator.CreateInstance(type,new object[]{"test-pipe","test-token",false});Set(form,"connected",true);Call(form,"FillSettings",new Settings{ignoreLowerPriorityWishes=true,members=members,current=Rule(),upcoming=Rule(),effectiveDay="2026-10-29"});return form;}
    static void Save(Form form,string path){string line=null;var done=new ManualResetEvent(false);var outbox=new PanelOutbox(value=>{line=value;done.Set();},error=>{throw error;});Set(form,"outbox",outbox);Call(form,"SaveSettings");Check(done.WaitOne(2000),"save did not enqueue");File.WriteAllText(path,line);outbox.Dispose();}
    static void Dispose(Form form){((NotifyIcon)Field(form,"tray")).Dispose();((System.Windows.Forms.Timer)Field(form,"saveTimeout")).Dispose();((System.Windows.Forms.Timer)Field(form,"securityTimeout")).Dispose();form.Dispose();}
    [STAThread] static void Main(string[] args){
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        var first=Create(new Member[0]);
        try {
            var cutoff=(DateTimePicker)Field(first,"bookingCutoff");Check(cutoff.Value.Hour==7&&cutoff.Value.Minute==0,"booking cutoff default is not 07:00");cutoff.Value=DateTime.Today.AddHours(9);Check(((CheckBox)Field(first,"ignoreLowerPriorityWishes")).Checked,"priority policy not loaded");((CheckBox)Field(first,"ignoreLowerPriorityWishes")).Checked=false;
            var grid=(DataGridView)Field(first,"members");var input=(TextBox)Field(first,"newMemberName");var add=(Button)Field(first,"addMember");
            Check(grid.Rows.Count==0&&!grid.AllowUserToAddRows,"empty setup still depends on a hidden placeholder row");Check(add.Enabled&&input.Enabled,"add controls not ready");
            input.Text="  メンバーA  ";typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(add,new object[]{EventArgs.Empty});Check(grid.Rows.Count==1,"new row missing");Check((string)grid.Rows[0].Cells["Name"].Value=="メンバーA","name not trimmed");Check((bool)grid.Rows[0].Cells["Active"].Value,"new member inactive");Check(input.Text=="","name input not cleared");
            // Saving directly must also include the name still waiting in the dedicated input.
            input.Text="メンバーB";Save(first,Path.Combine(args[0],"empty-household.json"));Check(grid.Rows.Count==2,"pending name omitted from save");Check(File.ReadAllText(Path.Combine(args[0],"empty-household.json")).Contains("\"bookingCutoff\":540"),"booking cutoff picker not saved");Check(File.ReadAllText(Path.Combine(args[0],"empty-household.json")).Contains("\"ignoreLowerPriorityWishes\":false"),"priority policy not saved");
        }finally{Dispose(first);}
        var second=Create(new[]{new Member{id=1,name="既存メンバー",active=false}});
        try {
            var input=(TextBox)Field(second,"newMemberName");input.Text="新しいメンバー";Save(second,Path.Combine(args[0],"existing-household.json"));
            var grid=(DataGridView)Field(second,"members");Check(grid.Rows.Count==2,"existing household addition missing");Check(Convert.ToInt32(grid.Rows[0].Cells["Id"].Value)==1,"existing ID changed");Check(!(bool)grid.Rows[0].Cells["Active"].Value,"existing inactive state lost");Check((bool)grid.Rows[1].Cells["Active"].Value,"new member inactive");
        }finally{Dispose(second);}
        Console.WriteLine("Native member entry passed: empty setup, explicit name input, active defaults, pending-name save and existing-ID preservation.");
    }
}
