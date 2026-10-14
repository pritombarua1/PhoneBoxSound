' Starts PhoneBoxSound without a console window (use the tray icon to open or quit).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "pythonw -m phoneboxsound", 0, False
