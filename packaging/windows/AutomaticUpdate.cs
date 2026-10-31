using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

public sealed class UpdateAsset {public string name,browser_download_url;public long size;}
public sealed class UpdateRelease {public string tag_name,html_url;public bool draft,prerelease;public UpdateAsset[] assets;}
internal sealed class UpdateDownload {public UpdateRelease release;public UpdateAsset package,checksum;public Version version;}
internal sealed class UpdateUnavailableException : InvalidOperationException {public UpdateUnavailableException(string message,Exception inner):base(message,inner){}}
internal static class AutomaticUpdate {
    const long MaximumPackage=256L*1024*1024;
    internal static UpdateDownload Select(string json,string current,bool portable){
        var releases=new JavaScriptSerializer{MaxJsonLength=4*1024*1024}.Deserialize<UpdateRelease[]>(json);
        Version installed=ServerUpdate.ParseVersion(current);bool preview=current.Contains("-rc");UpdateRelease chosen=null;Version version=installed;
        foreach(var release in releases??new UpdateRelease[0]){
            if(release==null||release.draft||(!preview&&release.prerelease)||release.tag_name==null||!release.tag_name.StartsWith("v",StringComparison.Ordinal))continue;
            Version candidate;try{candidate=ServerUpdate.ParseVersion(release.tag_name.Substring(1));}catch(InvalidDataException){continue;}
            if(!preview&&release.tag_name.Contains("-rc"))continue;
            if(candidate>version){chosen=release;version=candidate;}
        }
        if(chosen==null)return null;
        string name=portable?"Bathjun-Portable-x64.zip":"Bathjun-Setup-x64.exe";UpdateAsset package=null,checksum=null;
        foreach(var asset in chosen.assets??new UpdateAsset[0]){if(asset.name==name)package=asset;if(asset.name==name+".sha256")checksum=asset;}
        if(package==null||checksum==null||package.size<=0||package.size>MaximumPackage||checksum.size<=0||checksum.size>4096)throw new InvalidDataException("この版の更新ファイルを取得できません。リリースページを確認してください。");
        foreach(var asset in new[]{package,checksum}){
            string expected="https://github.com/Slfinside/bathjun/releases/download/"+chosen.tag_name+"/"+asset.name;
            if(asset.browser_download_url!=expected)throw new InvalidDataException("更新ファイルの配布先を確認できませんでした。");
        }
        return new UpdateDownload{release=chosen,version=version,package=package,checksum=checksum};
    }
    internal static bool Allowed(Uri url){return url.Scheme=="https"&&url.Port==443&&url.UserInfo.Length==0&&(url.Host=="github.com"||url.Host=="api.github.com"||url.Host=="release-assets.githubusercontent.com"||url.Host=="objects.githubusercontent.com");}
    static void Fetch(string address,Stream output,long limit,Action<int> progress,CancellationToken cancel){
        var url=new Uri(address);ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        for(int hop=0;hop<6;hop++){
            cancel.ThrowIfCancellationRequested();if(!Allowed(url))throw new InvalidDataException("安全な更新配布先を確認できませんでした。");
            var request=(HttpWebRequest)WebRequest.Create(url);request.AllowAutoRedirect=false;request.Timeout=30000;request.ReadWriteTimeout=30000;request.UserAgent="Bathjun-Updater";request.Accept="application/vnd.github+json";
            using(cancel.Register(()=>request.Abort())){
                HttpWebResponse response;
                try{response=(HttpWebResponse)request.GetResponse();}
                catch(WebException error){cancel.ThrowIfCancellationRequested();var failed=error.Response as HttpWebResponse;if(failed!=null){var status=failed.StatusCode;failed.Dispose();if(status==HttpStatusCode.NotFound||status==HttpStatusCode.Unauthorized||status==HttpStatusCode.Forbidden)throw new UpdateUnavailableException("公開された更新情報を取得できませんでした。配布元が非公開・取得制限中は自動更新を利用できません。",error);}throw new IOException("更新ファイルを取得できませんでした。接続を確認して、もう一度お試しください。",error);}
                using(response){
                    int status=(int)response.StatusCode;if(status>=300&&status<400){url=new Uri(url,response.Headers["Location"]);continue;}
                    if(response.StatusCode!=HttpStatusCode.OK||response.ContentLength>limit)throw new InvalidDataException("更新ファイルの応答を確認できませんでした。");
                    using(var input=response.GetResponseStream()){var buffer=new byte[65536];long total=0;int last=-1,n;
                        while((n=input.Read(buffer,0,buffer.Length))>0){cancel.ThrowIfCancellationRequested();total+=n;if(total>limit)throw new InvalidDataException("更新ファイルが上限を超えています。");output.Write(buffer,0,n);if(progress!=null&&response.ContentLength>0){int percent=(int)(total*100/response.ContentLength);if(percent!=last){last=percent;progress(percent);}}}
                        if(response.ContentLength>=0&&total!=response.ContentLength)throw new IOException("更新ファイルのダウンロードが完了していません。");
                    }
                    return;
                }
            }
        }
        throw new IOException("更新配布先の転送を確認できませんでした。");
    }
    internal static UpdateDownload Check(string current,bool portable,CancellationToken cancel){using(var stream=new MemoryStream()){Fetch("https://api.github.com/repos/Slfinside/bathjun/releases?per_page=100",stream,4*1024*1024,null,cancel);return Select(Encoding.UTF8.GetString(stream.ToArray()),current,portable);}}
    internal static string Download(UpdateDownload update,string current,Action<int> progress,CancellationToken cancel){
        string folder=Path.Combine(Path.GetTempPath(),"Bathjun-Download-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(folder);
        try{
            string checksum;using(var data=new MemoryStream()){Fetch(update.checksum.browser_download_url,data,4096,null,cancel);checksum=Encoding.ASCII.GetString(data.ToArray());}
            var match=Regex.Match(checksum.Trim(),"^([a-fA-F0-9]{64})[ \\t]+\\*?"+Regex.Escape(update.package.name)+"$");if(!match.Success)throw new InvalidDataException("更新ファイルのチェックサムを確認できませんでした。");
            string path=Path.Combine(folder,update.package.name),part=path+".part";
            using(var output=new FileStream(part,FileMode.CreateNew,FileAccess.Write,FileShare.None))Fetch(update.package.browser_download_url,output,update.package.size,progress,cancel);
            cancel.ThrowIfCancellationRequested();VerifyPackage(part,update.package.size,match.Groups[1].Value);
            File.Move(part,path);File.WriteAllText(path+".sha256",checksum);
            Version candidate=path.EndsWith(".zip",StringComparison.OrdinalIgnoreCase)?ValidatePortable(path,ServerUpdate.ParseVersion(current)):ServerUpdate.ValidateInstaller(path,ServerUpdate.ParseVersion(current));
            if(candidate!=update.version)throw new InvalidDataException("リリースと更新ファイルのバージョンが一致しません。");return path;
        }catch{try{Directory.Delete(folder,true);}catch{}throw;}
    }
    internal static void VerifyPackage(string path,long size,string digest){if(new FileInfo(path).Length!=size||!string.Equals(ServerUpdate.Hash(path),digest,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("更新ファイルのSHA-256が一致しません。もう一度取得してください。");}
    static string EntryName(string full){
        const string prefix="Bathjun-Portable/";
        if(!full.StartsWith(prefix,StringComparison.Ordinal)||full.Contains("\\")||full.Contains(":"))throw new InvalidDataException("ZIP内のパスを確認できませんでした。");
        string path=full.Substring(prefix.Length);foreach(string part in path.Split('/'))if(part.Length==0||part=="."||part==".."||part.TrimEnd(new[]{' ','.'})!=part)throw new InvalidDataException("ZIP内のパスを確認できませんでした。");
        if(path!="build-manifest.json"&&!path.StartsWith("app/",StringComparison.Ordinal)&&!path.StartsWith("bin/",StringComparison.Ordinal)&&path!="start-local.cmd"&&path!="family-password.cmd"&&path!="はじめる.cmd"&&path!="はじめに.txt"&&path!="Windowsの使い方.txt")throw new InvalidDataException("ZIPに更新対象外のファイルがあります。");
        if(path.EndsWith(".sqlite",StringComparison.OrdinalIgnoreCase)||path.EndsWith(".db",StringComparison.OrdinalIgnoreCase)||path.Contains("/data/")||Path.GetFileName(path).StartsWith(".env",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("ZIPにデータファイルが含まれています。");return path;
    }
    internal static Version ValidatePortable(string path,Version current){
        using(var archive=new ZipArchive(File.OpenRead(path),ZipArchiveMode.Read)){
            if(archive.Entries.Count>20000)throw new InvalidDataException("ZIPのファイル数が上限を超えています。");
            var entries=new Dictionary<string,ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);long total=0;
            foreach(var entry in archive.Entries){string name=EntryName(entry.FullName);if(entries.ContainsKey(name)||entry.Length>MaximumPackage||(total+=entry.Length)>512L*1024*1024)throw new InvalidDataException("ZIPの内容を確認できませんでした。");entries.Add(name,entry);}
            if(!entries.ContainsKey("build-manifest.json")||!entries.ContainsKey("app/package.json")||!entries.ContainsKey("bin/Bathjun-Server.exe")||!entries.ContainsKey("start-local.cmd"))throw new InvalidDataException("ふろきゅ～のZIP版を選んでください。");
            Dictionary<string,object> manifest;using(var reader=new StreamReader(entries["build-manifest.json"].Open())){if(entries["build-manifest.json"].Length>4*1024*1024)throw new InvalidDataException("ZIPのマニフェストが大きすぎます。");manifest=new JavaScriptSerializer{MaxJsonLength=4*1024*1024}.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());}
            if(!manifest.ContainsKey("distribution")||Convert.ToString(manifest["distribution"])!="portable-local")throw new InvalidDataException("ZIP版の配布形式を確認できませんでした。");
            var files=manifest["files"] as Dictionary<string,object>;if(files==null||files.Count!=entries.Count-1)throw new InvalidDataException("ZIPのファイル一覧が一致しません。");
            foreach(var file in files){ZipArchiveEntry entry;if(!entries.TryGetValue(file.Key,out entry)||file.Key=="build-manifest.json")throw new InvalidDataException("ZIPのファイル一覧が一致しません。");using(var algorithm=SHA256.Create())using(var stream=entry.Open()){string digest=BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-","").ToLowerInvariant();if(!string.Equals(digest,Convert.ToString(file.Value),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("ZIP内のファイルが変更されています。");}}
            Version version=ServerUpdate.ParseVersion(Convert.ToString(manifest["version"]));if(version<=current)throw new InvalidDataException("現在より新しいZIP版を選んでください。");
            if(entries["app/package.json"].Length>65536)throw new InvalidDataException("ZIPのバージョン情報を確認できませんでした。");
            using(var reader=new StreamReader(entries["app/package.json"].Open())){var package=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(reader.ReadToEnd());if(ServerUpdate.ParseVersion(Convert.ToString(package["version"]))!=version)throw new InvalidDataException("ZIPのバージョンが一致しません。");}return version;
        }
    }
    internal static void ApplyPortable(string path,string root,Action<string> beforeInstall=null){
        string work=Path.Combine(root,".bathjun-update-"+Guid.NewGuid().ToString("N")),fresh=Path.Combine(work,"new"),backup=Path.Combine(work,"old");Directory.CreateDirectory(fresh);Directory.CreateDirectory(backup);
        var moved=new List<string>();var installed=new List<string>();bool recovered=true;
        try{
            using(var archive=new ZipArchive(File.OpenRead(path),ZipArchiveMode.Read))foreach(var entry in archive.Entries){string name=EntryName(entry.FullName);string target=Path.Combine(fresh,name.Replace('/',Path.DirectorySeparatorChar));Directory.CreateDirectory(Path.GetDirectoryName(target));using(var input=entry.Open())using(var output=File.Create(target))input.CopyTo(output);}
            foreach(string source in Directory.GetFileSystemEntries(fresh)){string name=Path.GetFileName(source),target=Path.Combine(root,name);if(beforeInstall!=null)beforeInstall(name);if(File.Exists(target)){File.Move(target,Path.Combine(backup,name));moved.Add(name);}else if(Directory.Exists(target)){Directory.Move(target,Path.Combine(backup,name));moved.Add(name);}if(Directory.Exists(source))Directory.Move(source,target);else File.Move(source,target);installed.Add(name);}
        }catch{
            try{foreach(string name in installed){string target=Path.Combine(root,name);if(Directory.Exists(target))Directory.Delete(target,true);else if(File.Exists(target))File.Delete(target);}foreach(string name in moved){string old=Path.Combine(backup,name),target=Path.Combine(root,name);if(Directory.Exists(old))Directory.Move(old,target);else File.Move(old,target);}}catch{recovered=false;}throw;
        }finally{if(recovered)try{Directory.Delete(work,true);}catch{}}
    }
}
