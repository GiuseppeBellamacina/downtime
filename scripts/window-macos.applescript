-- downtime, macOS side: minimizes and restores windows through System Events, and counts them.
--
--   osascript window-macos.applescript <mode> <action> <key> <never>
--
--   mode    "pid": the windows of the process with that unix id (key is the id)
--           "title": the windows whose title contains <key>, in any process not named in <never>
--   action  "minimize", "restore" or "count"
--   never   process names that are the user's own working windows, as ",name,name,"
--
-- It prints how many windows it went through. macOS asks once for the Accessibility permission.
on run argv
	set theMode to item 1 of argv
	set theAction to item 2 of argv
	set theKey to item 3 of argv
	set theNever to item 4 of argv
	set touched to 0
	tell application "System Events"
		if theMode is "pid" then
			set candidates to every process whose unix id is (theKey as integer)
		else
			set candidates to every process whose background only is false
		end if
		repeat with proc in candidates
			set procName to name of proc
			if theMode is "pid" or (theNever does not contain ("," & procName & ",")) then
				repeat with w in (windows of proc)
					set wName to ""
					try
						set wName to name of w
					end try
					if theMode is "pid" or wName contains theKey then
						if theAction is "minimize" then
							set value of attribute "AXMinimized" of w to true
						else if theAction is "restore" then
							set value of attribute "AXMinimized" of w to false
						end if
						set touched to touched + 1
					end if
				end repeat
			end if
		end repeat
	end tell
	return touched as text
end run
