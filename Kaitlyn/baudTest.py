import serial
s=serial.Serial('/dev/serial0', 9600, timeout=3)
while True:
 data=s.readline()
 if data:
  print(repr(data))
