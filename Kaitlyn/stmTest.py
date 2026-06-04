import serial
import time

ser = serial.Serial('/dev/ttyAMA0', 115200, timeout=2)
time.sleep(0.5)

print("Polling hall sensors \n")

try:
	while True:
		ser.write(b'R')
		time.sleep(0.1)
		response = ser.readline()
		if response:
			print(response.decode(errors='ignore').strip())
except KeyboardInterrupt:
	ser.close()
