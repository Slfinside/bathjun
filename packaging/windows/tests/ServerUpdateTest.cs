using System;
using System.IO;
using System.Reflection;
internal static class ServerUpdateTest {
    static object Call(string name,params object[] args){return typeof(Member).Assembly.GetType("ServerUpdate").GetMethod(name,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}
    static void Rejected(string path,Version current){try{Call("ValidateInstaller",path,current);throw new Exception("Invalid update accepted");}catch(TargetInvocationException e){if(!(e.InnerException is InvalidDataException))throw;}}
    static void Main(string[] args){
        string root=(string)typeof(Member).Assembly.GetType("ServerUpdate").GetProperty("InstallRoot",BindingFlags.Static|BindingFlags.NonPublic).GetValue(null,null);if(!Directory.Exists(root))throw new Exception("InstallRoot did not resolve");
        if(!(bool)Call("RestartProtected","{\"ok\":true,\"state\":{\"phase\":\"ready\",\"serverPowerHeld\":true}}"))throw new Exception("Protected restart not accepted");
        foreach(string response in new[]{"{}","invalid","{\"ok\":false,\"state\":{\"phase\":\"ready\",\"serverPowerHeld\":true}}","{\"ok\":true,\"state\":{\"phase\":\"ready\",\"serverPowerHeld\":false}}","{\"ok\":true,\"state\":{\"phase\":\"starting\",\"serverPowerHeld\":true}}"})if((bool)Call("RestartProtected",response))throw new Exception("Unprotected or incomplete restart accepted");
        var pauses=new System.Collections.Generic.List<int>();int probes=0;Func<bool> ready=()=>++probes==3;Action<int> delay=value=>pauses.Add(value);Call("WaitForRestart",ready,delay);
        if(probes!=3||string.Join(",",pauses)!="500,500,1000")throw new Exception("Restart confirmation released protection too early");
        pauses.Clear();try{Call("WaitForRestart",new Func<bool>(()=>false),delay);throw new Exception("Missing restart accepted");}catch(TargetInvocationException error){if(!(error.InnerException is IOException)||pauses.Count!=120)throw;}
        string marker=Path.Combine(args[1],"handoff.ready");try{try{Call("WaitForReady",System.Diagnostics.Process.GetCurrentProcess(),marker,0);throw new Exception("Helper without power acknowledgement accepted");}catch(TargetInvocationException error){if(!(error.InnerException is IOException))throw;}File.WriteAllText(marker,"power-held");Call("WaitForReady",System.Diagnostics.Process.GetCurrentProcess(),marker,0);}finally{File.Delete(marker);}
        var old=(Version)Call("ParseVersion","1.3.0");var rc=(Version)Call("ParseVersion","2.0.0-rc");var rc2=(Version)Call("ParseVersion","2.0.0-rc2");if(rc2!=(Version)Call("ParseVersion","2.0.0-rc.2"))throw new Exception("RC aliases differ");var stable=(Version)Call("ParseVersion","2.0.0");
        if(!(old<rc&&rc<rc2&&rc2<stable)||rc.ToString()!="2.0.0.32769")throw new Exception("RC/stable update ordering is invalid");
        var beta=(Version)Call("ParseVersion","2.0.0-beta1");if(!(old<beta&&beta<rc)||beta.ToString()!="2.0.0.1")throw new Exception("Beta ordering failed");
        foreach(string invalid in new[]{"2.0.0-rc0","2.0.0-rc65535","2.0.0-rc.0","2.0.0-rc.65535","2.0.0-beta","65536.0.0","2.0.0-rcx"}){try{Call("ParseVersion",invalid);throw new Exception("Invalid release version accepted");}catch(TargetInvocationException e){if(!(e.InnerException is InvalidDataException))throw;}}
        var current=new Version("1.0.0");var version=(Version)Call("ValidateInstaller",args[0],current);if(version<=current)throw new Exception("Upgrade missing");
        if(args.Length>2)Call("ValidateInstaller",args[2],current);
        Rejected(args[0],version);Rejected(args[0],new Version("1000.0.0"));
        string test=Path.Combine(args[1],"test-installer.exe");File.Copy(args[0],test,true);File.WriteAllText(test+".sha256",new string('0',64)+"  test-installer.exe\n");Rejected(test,current);
        File.WriteAllText(test+".sha256",Call("Hash",test)+"  test-installer.exe\n");Call("ValidateInstaller",test,current);
        Console.WriteLine("Update checks passed: power handoff acknowledgement, protected restart, timeout, upgrade version, downgrade refusal and SHA-256.");
    }
}
