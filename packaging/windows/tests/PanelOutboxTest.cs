using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;
// Run against the compiled ServerPanel assembly; no display or power APIs are used.
internal static class PanelOutboxTest {
    static void Check(bool value,string message){if(!value)throw new Exception(message);}
    static void Main(){
        var entered=new ManualResetEvent(false);var release=new ManualResetEvent(false);var complete=new ManualResetEvent(false);var received=new List<string>();
        var box=new PanelOutbox(line=>{entered.Set();release.WaitOne();lock(received){received.Add(line);if(received.Count==33)complete.Set();}},error=>{throw error;});
        Check(box.Post(new{id="0",command="settings/save",payload=new{name="利用者"}}),"first enqueue");Check(entered.WaitOne(2000),"writer entered");
        var clock=Stopwatch.StartNew();
        for(int i=1;i<=32;i++)Check(box.Post(new{id=i.ToString()}),"queue capacity");
        Check(!box.Post(new{id="overflow"}),"bounded queue must reject excess");Check(clock.ElapsedMilliseconds<500,"UI enqueue blocked on pipe");
        release.Set();Check(complete.WaitOne(2000),"writer did not drain");box.Dispose();Check(!box.Post(new{id="closed"}),"closed queue must reject");
        var json=new JavaScriptSerializer();for(int i=0;i<received.Count;i++){var reply=json.Deserialize<Dictionary<string,object>>(received[i]);Check((string)reply["id"]==i.ToString(),"request order changed");}
        var failure=new ManualResetEvent(false);var broken=new PanelOutbox(line=>{throw new System.IO.IOException("test disconnect");},error=>{if(error is System.IO.IOException)failure.Set();});Check(broken.Post(new{id="fail"}),"failed write enqueue");Check(failure.WaitOne(2000),"failure callback missing");broken.Dispose();
        Console.WriteLine("Native transport passed: blocked writes never block enqueue, bounded queue, FIFO JSON, close and failure reporting.");
    }
}
