import serial
import time

s=serial.Serial('/dev/ttyAMA0', 115200, timeout=1)
time.sleep(0.5)

print("Reading hall sensors (Ctrl + c to stop) ...\n")
while True:
 s.write(b'R')
 time.sleep(0.1)
 print(s.readline().decode().strip())
 time.sleep(1)
