# ~/.bashrc — Linux Leptocline
[ -z "$PS1" ] && return

HISTCONTROL=ignoreboth
HISTSIZE=10000
HISTFILESIZE=50000
shopt -s histappend checkwinsize

# blue user@host, white path, and a prompt that turns red when the last
# command failed — the one piece of state worth spending colour on.
__lepto_ps1() {
  local rc=$?
  local blue='\[\e[1;38;2;60;110;255m\]' white='\[\e[97m\]' grey='\[\e[90m\]' off='\[\e[0m\]'
  local mark='\[\e[1;38;2;60;110;255m\]'
  [ $rc -ne 0 ] && mark='\[\e[1;31m\]'
  PS1="${blue}\u${grey}@${blue}\h${off} ${white}\w${off} ${mark}\$${off} "
}
PROMPT_COMMAND=__lepto_ps1

case "$TERM" in xterm*|rxvt*|screen*|tmux*) ;; *) unset PROMPT_COMMAND; PS1='\u@\h:\w\$ ' ;; esac

alias ls='ls --color=auto --group-directories-first'
alias ll='ls -alFh'
alias la='ls -A'
alias grep='grep --color=auto'
alias ip='ip -color=auto'
alias df='df -h'
alias free='free -m'
alias ..='cd ..'
alias ...='cd ../..'
alias ports='ss -tulpn'
alias myip='curl -s https://ifconfig.me; echo'

[ -f ~/.bash_aliases ] && . ~/.bash_aliases
[ -f /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion

export EDITOR=micro
export PATH="$HOME/.local/bin:$PATH"

# The greeting, but only for a real interactive terminal — not for scp, not
# for a subshell inside an editor.
if [ -t 1 ] && [ -z "${LEPTO_NO_FETCH:-}" ] && [ "${SHLVL:-1}" -le 1 ]; then
  command -v leptofetch >/dev/null && leptofetch
fi
