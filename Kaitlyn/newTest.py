import serial, time
s=serial.Serial('/dev/serial0', 9600, timeout=2)
time.sleep(0.5)
s.write(b'R')
time.sleep(0.1)
print(repr(s.readline()))

