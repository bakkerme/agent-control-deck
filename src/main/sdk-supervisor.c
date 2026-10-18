// Linux-only, per-run owner. No privileged operation or global configuration.
// fd 0/1/2 are the unmodified SDK protocol; fd 3 is backend lifetime; fd 4
// reports the SDK PID to its owning parent (never protocol output or secrets).
#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <poll.h>
#include <signal.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <dirent.h>
#include <string.h>
#include <limits.h>
static volatile sig_atomic_t stopping = 0;
static void stop(int signal_number) { (void)signal_number; stopping = 1; }
static void kill_children(void) {
  DIR *proc = opendir("/proc"); if (!proc) return;
  struct dirent *entry;
  while ((entry = readdir(proc))) {
    char *end; long pid = strtol(entry->d_name, &end, 10);
    if (*end || pid <= 0) continue;
    char path[96], line[4096]; snprintf(path, sizeof(path), "/proc/%ld/stat", pid);
    FILE *stat = fopen(path, "r"); if (!stat) continue;
    size_t length = fread(line, 1, sizeof(line) - 1, stat); line[length] = '\0';
    char *tail = length ? strrchr(line, ')') : NULL;
    char state; long parent = 0;
    if (tail && sscanf(tail + 1, " %c %ld", &state, &parent) == 2 && parent == (long)getpid()) kill((pid_t)pid, SIGKILL);
    fclose(stat);
  }
  closedir(proc);
}
int main(int argc, char **argv) {
  if (argc < 3) return 125;
  char *end; errno = 0; long expected = strtol(argv[1], &end, 10);
  if (errno || *end || expected <= 1 || expected > INT_MAX || getppid() != (pid_t)expected || prctl(PR_SET_CHILD_SUBREAPER, 1) != 0 ||
      fcntl(3, F_SETFD, FD_CLOEXEC) < 0 || fcntl(4, F_SETFD, FD_CLOEXEC) < 0) return 125;
#ifdef ACD_SUPERVISOR_PRE_OWNER_TEST
  if (write(4, "P", 1) != 1) return 125;
  char checkpoint; if (read(5, &checkpoint, 1) < 0) return 125; close(5);
#endif
  int owner = (int)syscall(SYS_pidfd_open, (pid_t)expected, 0);
  if (owner < 0 || getppid() != (pid_t)expected || fcntl(owner, F_SETFD, FD_CLOEXEC) < 0) return 125;
  signal(SIGPIPE, SIG_IGN);
  struct sigaction action = {0}; action.sa_handler = stop; sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
  pid_t guardian = getpid();
  pid_t sdk = fork();
  if (sdk < 0) return 125;
  if (sdk == 0) {
    signal(SIGPIPE, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != guardian) _exit(125);
    close(3); close(4); close(owner);
#ifdef ACD_SUPERVISOR_TEST
    close(5);
#endif
    execvp(argv[2], argv + 2);
    _exit(127);
  }
#ifdef ACD_SUPERVISOR_TEST
  // Compiled only into the fault-test binary; absent from production builds.
  char checkpoint; if (read(5, &checkpoint, 1) < 0) stopping = 1; close(5);
#endif
  if (dprintf(4, "ACD_SUPERVISOR_1 %ld\n", (long)sdk) < 0) stopping = 1;
  close(4); close(0);
  int sdk_status = 0, have_status = 0;
  while (!stopping) {
    int status; pid_t exited;
    while ((exited = waitpid(-1, &status, WNOHANG)) > 0) if (exited == sdk) { sdk_status = status; have_status = 1; stopping = 1; }
    if (stopping) break;
    struct pollfd lifetime[2] = {{.fd = 3, .events = POLLIN | POLLHUP}, {.fd = owner, .events = POLLIN}};
    int result = poll(lifetime, 2, 25);
    if (result > 0 && lifetime[1].revents) stopping = 1;
    if (result > 0 && lifetime[0].revents) {
      char byte;
      if (read(3, &byte, 1) <= 0) stopping = 1;
    } else if (result < 0 && errno != EINTR) stopping = 1;
  }
  // Killing an ancestor adopts its orphaned descendants here, even if they
  // changed session/group or double-forked. Reap, then repeat until ECHILD.
  // Never exit merely because a kill signal was sent.
  for (;;) {
    kill_children();
    int status; pid_t exited;
    while ((exited = waitpid(-1, &status, WNOHANG)) > 0) if (exited == sdk) { sdk_status = status; have_status = 1; }
    if (exited < 0 && errno == ECHILD) break;
    poll(NULL, 0, 5);
  }
  if (have_status && WIFEXITED(sdk_status)) return WEXITSTATUS(sdk_status);
  return 128 + (have_status && WIFSIGNALED(sdk_status) ? WTERMSIG(sdk_status) : SIGTERM);
}
