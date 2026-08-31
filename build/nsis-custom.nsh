; The assisted NSIS uninstaller normally restores $INSTDIR from its registry entry.
; Its temporary copy receives the original path through `_?=...`; parse the raw
; command line so paths containing spaces are preserved even when NSIS splits the
; argument into multiple tokens.
!macro customUnInit
  ${StdUtils.GetAllParameters} $R8 "0"
  StrLen $R7 $R8
  IntOp $R7 $R7 - 3
  StrCpy $R9 ""
  StrCpy $R6 0
  ${Do}
    StrCpy $R5 $R8 3 $R6
    ${If} $R5 == "_?="
      IntOp $R6 $R6 + 3
      StrCpy $R9 $R8 "" $R6
      ${Break}
    ${EndIf}
    IntOp $R6 $R6 + 1
  ${LoopUntil} $R6 > $R7
  ${StdUtils.TrimStr} $R9
  StrCpy $R5 $R9 1
  ${If} $R5 == '"'
    StrLen $R7 $R9
    IntOp $R7 $R7 - 2
    StrCpy $R9 $R9 $R7 1
  ${EndIf}
  ${If} $R9 != ""
    StrCpy $INSTDIR $R9
  ${Else}
    StrCpy $INSTDIR "$EXEDIR"
  ${EndIf}
!macroend
