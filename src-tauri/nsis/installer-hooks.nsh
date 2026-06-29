!macro NSIS_HOOK_POSTINSTALL
  ; 安装完成后，显式重写已存在的快捷方式图标，避免 Windows 继续沿用旧版空 IconLocation 缓存。
  IfFileExists "$SMPROGRAMS\CCSwitchMulti.lnk" 0 +2
    CreateShortCut "$SMPROGRAMS\CCSwitchMulti.lnk" "$INSTDIR\cc-switch.exe" "" "$INSTDIR\cc-switch.exe" 0

  ; 只有安装器已经创建过桌面快捷方式时才更新，不额外改变用户的桌面快捷方式选择。
  IfFileExists "$DESKTOP\CCSwitchMulti.lnk" 0 +2
    CreateShortCut "$DESKTOP\CCSwitchMulti.lnk" "$INSTDIR\cc-switch.exe" "" "$INSTDIR\cc-switch.exe" 0

  ; 已固定到任务栏的快捷方式不会总是随开始菜单快捷方式刷新，显式修正可避免旧图标缓存继续命中。
  IfFileExists "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\CCSwitchMulti.lnk" 0 +2
    CreateShortCut "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\CCSwitchMulti.lnk" "$INSTDIR\cc-switch.exe" "" "$INSTDIR\cc-switch.exe" 0
!macroend
