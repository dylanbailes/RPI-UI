import serial
import time
ser = serial.Serial('/dev/ttyAMA0', 115200, timeout=1)
time.sleep(1)
startup = ser.read(64)
print("Startup Msg:", startup.decode(errors='ignore'))

ser.write(b'Hello STM32\r\n')
time.sleep(0.5)

response = ser.read(64)
print("Echo back:", response.decode(errors='ignore'))
ser.close()
