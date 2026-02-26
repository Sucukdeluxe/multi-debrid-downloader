#define MyAppName "Real-Debrid Downloader"
#define MyAppExeName "Real-Debrid-Downloader.exe"

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#ifndef MySourceDir
  #define MySourceDir "..\\dist\\Real-Debrid-Downloader"
#endif

#ifndef MyOutputDir
  #define MyOutputDir "release"
#endif

#ifndef MyIconFile
  #define MyIconFile "..\\assets\\app_icon.ico"
#endif

[Setup]
AppId={{C0E95B39-389E-4D2C-8E1E-12A44E8AE8E0}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Sucukdeluxe
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir={#MyOutputDir}
OutputBaseFilename=Real-Debrid-Downloader-Setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile={#MyIconFile}

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#MySourceDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MyIconFile}"; DestDir: "{app}"; DestName: "app_icon.ico"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\app_icon.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\app_icon.ico"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{#MyAppName} starten"; Flags: nowait postinstall skipifsilent
