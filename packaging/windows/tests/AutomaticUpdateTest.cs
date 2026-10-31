using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
internal static class AutomaticUpdateTest {
    static readonly Type Backend=typeof(Member).Assembly.GetType("AutomaticUpdate");
    static object Call(string name,params object[] args){return Backend.GetMethod(name,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}
    static void Rejected(string method,params object[] args){try{Call(method,args);throw new Exception("Invalid update accepted: "+method);}catch(TargetInvocationException error){if(!(error.InnerException is InvalidDataException))throw;}}
    static object Release(string version,bool preview=false,bool portable=false){string name=portable?"Bathjun-Portable-x64.zip":"Bathjun-Setup-x64.exe",url="https://github.com/Slfinside/bathjun/releases/download/v"+version+"/";return new{tag_name="v"+version,draft=false,prerelease=preview,assets=new[]{new{name=name,size=100,browser_download_url=url+name},new{name=name+".sha256",size=100,browser_download_url=url+name+".sha256"}}};}
    static string Zip(string folder,string version,string extra=null){
        string path=Path.Combine(folder,Guid.NewGuid().ToString("N")+".zip");
        var files=new Dictionary<string,string>{{"app/package.json","{\"version\":\""+version+"\"}"},{"app/new.txt","new app"},{"bin/Bathjun-Server.exe","test binary"},{"start-local.cmd","new launcher"}};
        if(extra!=null)files.Add(extra,"unexpected");var hashes=new Dictionary<string,string>();
        foreach(var file in files)using(var sha=SHA256.Create())hashes.Add(file.Key,BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(file.Value))).Replace("-","").ToLowerInvariant());
        files.Add("build-manifest.json",new JavaScriptSerializer().Serialize(new{version=version,distribution="portable-local",files=hashes}));
        using(var stream=File.Create(path))using(var archive=new ZipArchive(stream,ZipArchiveMode.Create))foreach(var file in files)using(var writer=new StreamWriter(archive.CreateEntry("Bathjun-Portable/"+file.Key).Open(),new UTF8Encoding(false)))writer.Write(file.Value);
        return path;
    }
    static void Main(){
        var json=new JavaScriptSerializer();string releases=json.Serialize(new[]{Release("1.3.0"),Release("2.0.0-rc.2",true),Release("2.0.0")});
        object stable=Call("Select",releases,"1.3.0",false);if((Version)stable.GetType().GetField("version").GetValue(stable)!=new Version(2,0,0,65535))throw new Exception("Stable update selection failed");
        object rc=Call("Select",json.Serialize(new[]{Release("2.0.0-rc.2",true)}),"2.0.0-rc",false);if(rc==null)throw new Exception("RC updates excluded");
        if(Call("Select",json.Serialize(new[]{Release("2.0.0-rc.2",true)}),"1.3.0",false)!=null)throw new Exception("Stable installs opted into preview");
        if(Call("Select",releases,"2.0.0",false)!=null)throw new Exception("Equal version treated as upgrade");
        if(Call("Select",json.Serialize(new[]{Release("2.0.0",false,true)}),"1.3.0",true)==null)throw new Exception("Portable update selection failed");
        Rejected("Select",releases.Replace("https://github.com/Slfinside/bathjun/releases/download/","https://example.test/"),"1.3.0",false);
        Rejected("Select","[{\"tag_name\":\"v2.0.0\",\"assets\":[]}]","1.3.0",false);
        foreach(string address in new[]{"http://github.com/a","https://github.com.evil.test/a","https://user@github.com/a","https://github.com:8443/a","file:///tmp/a"})if((bool)Call("Allowed",new Uri(address)))throw new Exception("Untrusted redirect allowed");
        string folder=Path.Combine(Path.GetTempPath(),"bathjun-update-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(folder);
        try{
            string bytes=Path.Combine(folder,"package.part");File.WriteAllText(bytes,"downloaded");
            string digest;using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(bytes))).Replace("-","").ToLowerInvariant();
            Call("VerifyPackage",bytes,new FileInfo(bytes).Length,digest);Rejected("VerifyPackage",bytes,new FileInfo(bytes).Length,new string('0',64));Rejected("VerifyPackage",bytes,new FileInfo(bytes).Length+1,digest);
            string archive=Zip(folder,"2.0.0");Call("ValidatePortable",archive,new Version(1,3,0,65535));Rejected("ValidatePortable",archive,new Version(2,0,0,65535));
            Rejected("ValidatePortable",Zip(folder,"2.0.0","../outside.txt"),new Version(1,0));Rejected("ValidatePortable",Zip(folder,"2.0.0","app/data/private.sqlite"),new Version(1,0));
            using(var zip=new ZipArchive(File.Open(archive,FileMode.Open),ZipArchiveMode.Update)){using(var writer=new StreamWriter(zip.GetEntry("Bathjun-Portable/app/new.txt").Open()))writer.Write("tampered");}
            Rejected("ValidatePortable",archive,new Version(1,0));archive=Zip(folder,"2.0.0");
            string root=Path.Combine(folder,"portable");Directory.CreateDirectory(Path.Combine(root,"app"));Directory.CreateDirectory(Path.Combine(root,"bin"));Directory.CreateDirectory(Path.Combine(root,"my-data"));File.WriteAllText(Path.Combine(root,"app","old.txt"),"old");File.WriteAllText(Path.Combine(root,"bin","old.exe"),"old binary");File.WriteAllText(Path.Combine(root,"my-data","state.sqlite"),"preserved");
            int count=0;Action<string> fail=name=>{if(++count==2)throw new IOException("Simulated locked file");};
            try{Call("ApplyPortable",archive,root,fail);throw new Exception("Failure not propagated");}catch(TargetInvocationException error){if(!(error.InnerException is IOException))throw;}
            if(!File.Exists(Path.Combine(root,"app","old.txt"))||!File.Exists(Path.Combine(root,"bin","old.exe")))throw new Exception("Rollback lost old files");
            Call("ApplyPortable",archive,root,null);
            if(!File.Exists(Path.Combine(root,"app","new.txt"))||File.Exists(Path.Combine(root,"app","old.txt"))||File.ReadAllText(Path.Combine(root,"my-data","state.sqlite"))!="preserved")throw new Exception("Portable update changed data or kept old app");
        }finally{Directory.Delete(folder,true);}
        Console.WriteLine("Automatic updates passed: channel selection, distribution, redirects, ZIP integrity, data preservation and rollback.");
    }
}
