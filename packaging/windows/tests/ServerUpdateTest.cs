using System;
using System.IO;
using System.Reflection;
internal static class ServerUpdateTest {
    static object Call(string name,params object[] args){return typeof(Member).Assembly.GetType("ServerUpdate").GetMethod(name,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}
    static void Rejected(string path,Version current){try{Call("ValidateInstaller",path,current);throw new Exception("Invalid update accepted");}catch(TargetInvocationException e){if(!(e.InnerException is InvalidDataException))throw;}}
    static void Main(string[] args){
        var old=(Version)Call("ParseVersion","1.3.0");var rc=(Version)Call("ParseVersion","2.0.0-rc");var rc2=(Version)Call("ParseVersion","2.0.0-rc.2");var stable=(Version)Call("ParseVersion","2.0.0");
        if(!(old<rc&&rc<rc2&&rc2<stable)||rc.ToString()!="2.0.0.1")throw new Exception("RC/stable update ordering is invalid");
        foreach(string invalid in new[]{"2.0.0-rc.0","2.0.0-rc.65535","2.0.0-beta","65536.0.0","2.0.0-rcx"}){try{Call("ParseVersion",invalid);throw new Exception("Invalid release version accepted");}catch(TargetInvocationException e){if(!(e.InnerException is InvalidDataException))throw;}}
        var current=new Version("1.0.0");var version=(Version)Call("ValidateInstaller",args[0],current);if(version<=current)throw new Exception("Upgrade missing");
        Rejected(args[0],version);Rejected(args[0],new Version("1000.0.0"));
        string test=Path.Combine(args[1],"test-installer.exe");File.Copy(args[0],test,true);File.WriteAllText(test+".sha256",new string('0',64)+"  test-installer.exe\n");Rejected(test,current);
        File.WriteAllText(test+".sha256",Call("Hash",test)+"  test-installer.exe\n");Call("ValidateInstaller",test,current);
        Console.WriteLine("Update package checks passed: upgrade version, downgrade refusal, SHA-256 failure and success.");
    }
}
