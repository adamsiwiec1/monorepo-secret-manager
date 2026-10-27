Output assets/quickstart.gif
Set Shell "bash"
Set FontSize 16
Set Width 1100
Set Height 640
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 40ms
Hide
Type 'sh docs/vhs/setup-demo.sh && export PATH=/tmp/msm-vhs-bin:$PATH PS1="$ " && cd /tmp/msm-vhs-demo && clear'
Enter
Sleep 1s
Show
Type "msm init -y"
Sleep 300ms
Enter
Sleep 2s
Type "msm list"
Sleep 300ms
Enter
Sleep 2s
Type "msm push"
Sleep 300ms
Enter
Sleep 2s
Type "rm apps/api/.env.stg && msm pull"
Sleep 300ms
Enter
Sleep 2s
Type "msm run api -- printenv API_URL"
Sleep 300ms
Enter
Sleep 2s
Sleep 2s
