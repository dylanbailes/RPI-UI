import serial
import time
ser = serial.Serial('/dev/ttyAMA0', 115200, timeout=2)
time.sleep(0.5)
msg = b'Hello STM32\r\n'
print(f"Sending {len(msg)} bytes: {msg}")
ser.write(msg)
time.sleep(0.5)

waiting = ser.in_waiting
print("Bytes waiting: {waiting}")
response = ser.read(waiting)
print(f"Raw response: {response}")
print(f"Hex response: {response}")

ser.close()
