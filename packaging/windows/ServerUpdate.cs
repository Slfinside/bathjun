using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ServerUpdate {
    internal const string ReleaseUrl="https://github.com/Slfinside/bathjun/releases";
    internal static string InstallRoot {get{return Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(new[]{Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar})).FullName;}}
    internal static string VersionAt(string root){var package=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"app","package.json")));return Convert.ToString(package["version"]);}
    internal static Version ParseVersion(string value) {
        var match=Regex.Match(value??"","^(\\d+)\\.(\\d+)\\.(\\d+)(?:-rc(?:\\.?([0-9]+))?)?$");
        int major,minor,patch,revision=65535;
        if(!match.Success||!int.TryParse(match.Groups[1].Value,out major)||!int.TryParse(match.Groups[2].Value,out minor)||!int.TryParse(match.Groups[3].Value,out patch)||major>65535||minor>65535||patch>65535)throw new InvalidDataException("バージョンを確認できませんでした。");
        if(value.Contains("-rc")){revision=1;if(match.Groups[4].Success&&!int.TryParse(match.Groups[4].Value,out revision))throw new InvalidDataException("RC番号を確認できませんでした。");if(revision<1||revision>=65535)throw new InvalidDataException("RC番号を確認できませんでした。");}
        return new Version(major,minor,patch,revision);
    }
    internal static string Hash(string path){using(var algorithm=SHA256.Create())using(var stream=File.OpenRead(path))return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
    internal static Version ValidateInstaller(string path,Version current) {
        var info=FileVersionInfo.GetVersionInfo(path);Version candidate;
        bool recognized=(info.ProductName=="ふろきゅ～"&&info.FileDescription=="ふろきゅ～ Windows x64 インストーラー") ||
            (info.ProductName=="ふろじゅん"&&info.FileDescription=="ふろじゅん Windows x64 インストーラー");
        if(!recognized || !Version.TryParse(info.FileVersion,out candidate))throw new InvalidDataException("ふろきゅ～のWindowsインストーラーを選んでください。");
        if(candidate<=current)throw new InvalidDataException("現在より新しいバージョンのインストーラーを選んでください。");
        string checksum=path+".sha256";
        if(File.Exists(checksum)) {
            string expected=File.ReadAllText(checksum).Trim().Split(new[]{' ','\t','\r','\n'},StringSplitOptions.RemoveEmptyEntries)[0];
            if(!Regex.IsMatch(expected,"^[a-fA-F0-9]{64}$")||!string.Equals(expected,Hash(path),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("SHA-256が一致しません。インストーラーとチェックサムを同じReleaseから取得し直してください。");
        }
        return candidate;
    }
    internal static Process Stage(string installer,string root,int serverPid,bool publicMode) {
        string folder=Path.Combine(Path.GetTempPath(),"Bathjun-Update-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(folder);
        string staged=Path.Combine(folder,Path.GetExtension(installer).Equals(".zip",StringComparison.OrdinalIgnoreCase)?"Bathjun-Portable-x64.zip":"Bathjun-Setup-x64.exe"),helper=Path.Combine(folder,"Bathjun-Update.exe");
        try {
            File.Copy(installer,staged);string digest=Hash(staged);
            if(digest!=Hash(installer))throw new IOException("インストーラーのコピーを確認できませんでした。");
            File.Copy(Application.ExecutablePath,helper);
            File.Copy(Application.ExecutablePath+".config",helper+".config");
            // No shell: every helper argument is quoted independently.
            return Process.Start(new ProcessStartInfo(helper,"--apply-update "+Quote(staged)+" "+Quote(root)+" "+Process.GetCurrentProcess().Id+" "+serverPid+" "+(publicMode?"public":"local")+" "+digest){UseShellExecute=false});
        }catch{try{Directory.Delete(folder,true);}catch{}throw;}
    }
    static string Quote(string value){return "\""+value.Replace("\"","")+"\"";}
    static void Wait(int id){try{using(var process=Process.GetProcessById(id)){if(!process.WaitForExit(60000))throw new TimeoutException("サーバーの終了を確認できませんでした。管理画面から停止して、もう一度更新してください。");}}catch(ArgumentException){}}
    internal static void Run(string[] args) {
        if(args.Length!=7)return;
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        using(var form=new Form{Text="ふろきゅ～ — 更新",ClientSize=new Size(490,170),StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false}) {
            form.AutoScaleDimensions=new SizeF(96,96);form.AutoScaleMode=AutoScaleMode.Dpi;
            var label=new Label{Text="サーバーの終了を待っています…",Dock=DockStyle.Fill,Padding=new Padding(20),Font=new Font("Yu Gothic UI",11)};form.Controls.Add(label);bool busy=true;
            form.FormClosing+=delegate(object sender,FormClosingEventArgs e){if(busy)e.Cancel=true;};
            form.Shown+=delegate{var work=new Thread(delegate(){
                try {
                    int panelId,serverId;if(!int.TryParse(args[3],out panelId)||!int.TryParse(args[4],out serverId)||panelId<=0||serverId<=0)throw new InvalidDataException("更新情報を確認できませんでした。");
                    string root=Path.GetFullPath(args[2]);
                    bool portable=Path.GetExtension(args[1]).Equals(".zip",StringComparison.OrdinalIgnoreCase);
                    if((!portable&&!File.Exists(Path.Combine(root,"Uninstall.exe"))) || !File.Exists(Path.Combine(root,"app","package.json")))throw new InvalidDataException("インストール先を確認できませんでした。");
                    if(portable){if(File.Exists(Path.Combine(root,"Uninstall.exe")))throw new InvalidDataException("インストール版にはインストーラーを使ってください。");AutomaticUpdate.ValidatePortable(args[1],ParseVersion(VersionAt(root)));}
                    else ValidateInstaller(args[1],ParseVersion(VersionAt(root)));
                    if(Hash(args[1])!=args[6])throw new InvalidDataException("更新ファイルが変更されています。");
                    Wait(serverId);Wait(panelId);
                    if(Hash(args[1])!=args[6])throw new InvalidDataException("更新ファイルが変更されています。");
                    form.BeginInvoke((MethodInvoker)delegate{label.Text="更新しています。予約データは残ります。\n完了するとサーバーを再起動します。";});
                    // NSIS requires /D last, without quotes even for paths with spaces.
                    if(portable)AutomaticUpdate.ApplyPortable(args[1],root);
                    else using(var install=Process.Start(new ProcessStartInfo(args[1],"/S /D="+root){UseShellExecute=true})) {
                        if(!install.WaitForExit(300000))throw new TimeoutException("更新完了を確認できませんでした。インストーラーが終了したか確認してください。");
                        if(install.ExitCode!=0)throw new IOException("更新に失敗しました（終了コード "+install.ExitCode+"）。保存したインストーラーを手動で実行してください。");
                    }
                    string script=Path.Combine(root,!portable&&args[5]=="public"?"start-public.cmd":"start-local.cmd");
                    Process.Start(new ProcessStartInfo(script){UseShellExecute=true,WorkingDirectory=root});
                    form.BeginInvoke((MethodInvoker)delegate{busy=false;form.Close();});
                }catch(Exception error){form.BeginInvoke((MethodInvoker)delegate{busy=false;label.Text="更新を完了できませんでした。\n"+error.Message;});}
                // Keep the staged installer on failure for manual recovery. Temp files
                // are in a unique directory and can be removed after the update.
            });work.IsBackground=true;work.Start();};
            Application.Run(form);
        }
    }
}
