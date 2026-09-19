# ? I'm just a test thingy for command execution in the web interface. To test, uncomment the config.py stuff.

import sys
import time
import random
import os

pid = os.getpid()
print(f"--- Process Started. PID: {pid} ---", flush=True)

try:
    for line in sys.stdin:
        s = line.rstrip("\n")
        if(s == "die"):
            sys.exit()
        chars = list(s)
        random.shuffle(chars)
        print(f"[{pid}] {''.join(chars)}", flush=True)
finally:
    print(f"--- Process {pid} entering final sleep ---", flush=True)
    time.sleep(10)
    print(f"--- Process {pid} exiting now ---", flush=True)