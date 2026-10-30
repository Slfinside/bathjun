Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "Sections.nsh"
Name "ふろじゅん"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Bathjun"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 16
BrandingText "ふろじゅん — 家族のおふろ予約"
VIProductVersion "${FILE_VERSION}"
VIAddVersionKey "ProductName" "ふろじゅん"
VIAddVersionKey "FileDescription" "ふろじゅん Windows x64 インストーラー"
VIAddVersionKey "FileVersion" "${FILE_VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" ""
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "ふろじゅんをセットアップ"
!define MUI_WELCOMEPAGE_TEXT "Windows 10・11（64bit）用。本体は管理者権限なしで導入し、このPC内だけで試せます。外部公開ツールは任意です（導入には管理者の許可が必要）。$\r$\n$\r$\n予約データはアプリ本体と別の場所に保存し、更新・アンインストールでも残します。"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION Launch
!define MUI_FINISHPAGE_RUN_TEXT "今すぐ起動して、家族の合い言葉を設定する"
!define MUI_FINISHPAGE_TEXT "インストールが完了しました。$\r$\n$\r$\n初回だけ、表示された画面で家族の合い言葉を設定してください。$\r$\n$\r$\n操作画面の「画面だけ消す」で、スリープさせずに消灯できます。終了は「サーバーを停止」。×は通知領域にしまいます。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Japanese"

!macro StopBeforeChanges Prefix
Function ${Prefix}EnsureStopped
  IfFileExists "$INSTDIR\bin\node.exe" 0 done
retry:
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\bin\node.exe", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p .r0'
  ${If} $0 == -1
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "ふろじゅんが起動しているか、ファイルが使用中です。起動画面で Ctrl+C を押して終了し、再試行してください。" IDRETRY retry
    Abort
  ${Else}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
done:
FunctionEnd
!macroend
!insertmacro StopBeforeChanges ""
!insertmacro StopBeforeChanges "un."

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "64bit版Windowsが必要です。"
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Windows 10以降が必要です。"
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext current
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bathjun"
  ${If} $0 != ""
    SectionSetFlags 2 ${SF_SELECTED}
  ${EndIf}
FunctionEnd

Section "ふろじゅん本体（必須）" SEC_MAIN
  SectionIn RO
  Call EnsureStopped
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\bin"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bathjun"
  File /r "${PAYLOAD}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ; Remove only the old app-owned shortcuts during a display-name upgrade.
  Delete "$DESKTOP\風呂じゅん.lnk"
  Delete "$SMPROGRAMS\風呂じゅん\風呂じゅんを起動.lnk"
  Delete "$SMPROGRAMS\風呂じゅん\固定URLで外部公開.lnk"
  Delete "$SMPROGRAMS\風呂じゅん\家族の合い言葉を変更.lnk"
  Delete "$SMPROGRAMS\風呂じゅん\使い方.lnk"
  Delete "$SMPROGRAMS\風呂じゅん\データフォルダ.lnk"
  Delete "$SMPROGRAMS\風呂じゅん\アンインストール.lnk"
  RMDir "$SMPROGRAMS\風呂じゅん"
  CreateDirectory "$SMPROGRAMS\ふろじゅん"
  CreateShortcut "$DESKTOP\ふろじゅん.lnk" "$INSTDIR\start-local.cmd" "" "$INSTDIR\app\public\icon.ico"
  CreateShortcut "$SMPROGRAMS\ふろじゅん\ふろじゅんを起動.lnk" "$INSTDIR\start-local.cmd" "" "$INSTDIR\app\public\icon.ico"
  CreateShortcut "$SMPROGRAMS\ふろじゅん\固定URLで外部公開.lnk" "$INSTDIR\start-public.cmd" "" "$INSTDIR\app\public\icon.ico"
  CreateShortcut "$SMPROGRAMS\ふろじゅん\家族の合い言葉を変更.lnk" "$INSTDIR\family-password.cmd"
  CreateShortcut "$SMPROGRAMS\ふろじゅん\使い方.lnk" "$INSTDIR\Windowsの使い方.txt"
  CreateShortcut "$SMPROGRAMS\ふろじゅん\データフォルダ.lnk" "$LOCALAPPDATA\BathjunData"
  CreateShortcut "$SMPROGRAMS\ふろじゅん\アンインストール.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bathjun" "DisplayName" "ふろじゅん"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bathjun" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bathjun" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bathjun" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bathjun" "DisplayIcon" "$INSTDIR\app\public\icon.ico"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bathjun" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bathjun" "NoRepair" 1
SectionEnd
Section /o "無料固定URL用のTailscale（初回に取得・署名検証して導入）" SEC_TAILSCALE
retry_tailscale:
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "$INSTDIR\install-tailscale.ps1"' $0
  ${If} $0 != 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Tailscaleの導入が完了していません。インターネット接続とWindowsの許可を確認してください。" IDRETRY retry_tailscale
    Abort
  ${EndIf}
SectionEnd
Section /o "このPC内モードをサインイン時に自動起動" SEC_AUTO
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bathjun" '"$SYSDIR\cmd.exe" /d /c start "" /min "$INSTDIR\start-autostart.cmd"'
SectionEnd
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN} "Node.js・SQLiteと必要なアプリを同梱。予約データと秘密鍵は配布物に含めません。"
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_TAILSCALE} "公式Windowsパッケージを取得し、署名を検証して導入します。初回はインターネットとWindowsの管理者の許可が必要です。Tailscaleは他のアプリでも使えるため、ふろじゅんの削除時には残します。"
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_AUTO} "このWindowsユーザーがサインインしたときだけ、最小化した画面で起動します。ブラウザーは自動では開きません。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END
Function Launch
  ExecShell "open" "$INSTDIR\start-local.cmd"
FunctionEnd
Section "Uninstall"
  SetRegView 64
  SetShellVarContext current
  Call un.EnsureStopped
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bathjun"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bathjun"
  Delete "$DESKTOP\ふろじゅん.lnk"
  RMDir /r "$SMPROGRAMS\ふろじゅん"
  ; Delete only known program directories. Never remove BathjunData or unknown user files.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\bin"
  Delete "$INSTDIR\start-public.cmd"
  Delete "$INSTDIR\start-local.cmd"
  Delete "$INSTDIR\family-password.cmd"
  Delete "$INSTDIR\start-autostart.cmd"
  Delete "$INSTDIR\install-tailscale.ps1"
  Delete "$INSTDIR\Windowsの使い方.txt"
  Delete "$INSTDIR\build-manifest.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
