; Layout fitting for translated labels.
;
; Every rect in pages.nsh is drawn for the English string and painted by our own control painter,
; which centres the text inside the control and clips whatever falls outside it. A translation is
; routinely wider (Russian "Установить сейчас" against "Install now"), so each such control is
; measured and resized instead of being trusted to fit.
!ifndef HARNESS_INSTALLER_TEXT_FIT
!define HARNESS_INSTALLER_TEXT_FIT

; Width of a label in device pixels, written into the named register. The text is read from the
; variable named by VAR because NSIS macro arguments cannot carry a string containing spaces.
; The installer fonts are created at the window's DPI, so the measurement needs no further scaling;
; only the padding added around it does.
!macro InstallerMeasureText HWND FONT VAR RESULT
    System::Call 'user32::GetDC(p ${HWND}) p.r0'
    System::Call 'gdi32::SelectObject(p r0, p ${FONT}) p.r1'
    StrLen $2 ${VAR}
    System::Alloc 8
    Pop $3
    System::Call 'gdi32::GetTextExtentPoint32W(p r0, w ${VAR}, i r2, p r3)'
    System::Call '*$3(i .${RESULT})'
    System::Free $3
    System::Call 'gdi32::SelectObject(p r0, p r1)'
    System::Call 'user32::ReleaseDC(p ${HWND}, p r0)'
!macroend

; Centres a control of the given device-pixel width on a 96-DPI column.
!macro InstallerFitControl HWND WIDTH CENTRE Y HEIGHT
    System::Call 'kernel32::MulDiv(i ${CENTRE}, i $InstallerDpi, i 96) i.r0'
    IntOp $0 $0 - $${WIDTH}
    IntOp $0 $0 / 2
    System::Call 'kernel32::MulDiv(i ${Y}, i $InstallerDpi, i 96) i.r1'
    System::Call 'kernel32::MulDiv(i ${HEIGHT}, i $InstallerDpi, i 96) i.r3'
    System::Call 'user32::MoveWindow(p ${HWND}, i r0, i r1, i ${WIDTH}, i r3, i 1)'
!macroend

; Device-pixel padding around a label, DPI-scaled.
!macro InstallerLabelPadding DIP PADDING
    System::Call 'kernel32::MulDiv(i ${DIP}, i $InstallerDpi, i 96) i.${PADDING}'
!macroend

!endif
