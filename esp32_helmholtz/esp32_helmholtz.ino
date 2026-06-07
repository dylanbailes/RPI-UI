#include <Arduino.h>
#include <math.h>

// ==============================================================================
// ======================== CONFIGURATION & CONSTANTS ===========================
// ==============================================================================
const int HELM_IN1_PIN = 21;   
const int HELM_IN2_PIN = 19;   
const int ELEC_IN1_PIN = 23;   
const int ELEC_IN2_PIN = 22;   
const int HE1_PIN = 34;        
const int HE2_PIN = 35;        

const int HELM_PWM_FREQ_HZ    = 20000;
const int ELEC_PWM_FREQ_HZ    = 20000;
const int PWM_RESOLUTION_BITS = 10;
const int PWM_MAX_VALUE       = (1 << PWM_RESOLUTION_BITS) - 1;
const int DEAD_TIME_US        = 2;

const unsigned long HELM_SAMPLE_INTERVAL_US = 1000000UL / HELM_PWM_FREQ_HZ;
const unsigned long ELEC_SAMPLE_INTERVAL_US = 1000000UL / ELEC_PWM_FREQ_HZ;

const float ADC_VREF       = 3.3;
const float ADC_RESOLUTION = 4095.0;

const float SENSOR_S5_V_PER_GAUSS = 0.010;
const float COUNTS_PER_GAUSS = (SENSOR_S5_V_PER_GAUSS / 5.0) * ADC_RESOLUTION;

float he1ZeroOffset = 2047.5;
float he2ZeroOffset = 2047.5;

const unsigned long HE_SAMPLE_RATE_HZ     = 2000;
const unsigned long HE_SAMPLE_INTERVAL_US = 1000000UL / HE_SAMPLE_RATE_HZ;

const float HELM_MIN_FREQ_HZ = 0.1;
const float HELM_MAX_FREQ_HZ = 250.0;
const float ELEC_MIN_FREQ_HZ = 0.1;
const float ELEC_MAX_FREQ_HZ = 100.0;

// ==============================================================================
// =========================== RUNTIME VARIABLES ================================
// ==============================================================================
enum WaveformType { WAVE_OFF, WAVE_STEP, WAVE_SQUARE, WAVE_SINE, WAVE_TRIANGLE };

volatile WaveformType  helmWaveform    = WAVE_OFF;
volatile float         helmFreqHz      = 50.0;
volatile float         helmAmpPercent  = 0.0;
volatile unsigned long helmWaveStartUs = 0;

volatile WaveformType  elecWaveform    = WAVE_OFF;
volatile float         elecFreqHz      = 10.0;
volatile float         elecAmpPercent  = 0.0;
volatile unsigned long elecWaveStartUs = 0;

// Normally only written by waveformTask (Core 0), but during calibration
// measureGaussAtPwm() (Core 1) seeds these to suppress waveformTask's
// change-detect.  volatile ensures Core 0 always reads from memory rather
// than a cached register value, so the seed is actually visible.
volatile int lastHelmPwm1 = 0;
volatile int lastHelmPwm2 = 0;
int lastElecPwm1 = 0;
int lastElecPwm2 = 0;

unsigned long prevHeSampleUs = 0;

portMUX_TYPE paramMux = portMUX_INITIALIZER_UNLOCKED;
TaskHandle_t waveTaskHandle = NULL;
TaskHandle_t calTaskHandle  = NULL;

// --- Calibration State ---
struct Point { float pwm; float gauss; };
Point calPoints[1000];
bool isCalibrating = false;
float helmLut[1001];
bool lutCalibrated = false;

// ==============================================================================
// ============================== HELPER FUNCTIONS ==============================
// ==============================================================================
void applyBipolarPWM(int pin1, int pin2, float dutyBipolar, volatile int &lastPwm1, volatile int &lastPwm2, int freqHz) {
    if (dutyBipolar >  PWM_MAX_VALUE) dutyBipolar =  PWM_MAX_VALUE;
    if (dutyBipolar < -PWM_MAX_VALUE) dutyBipolar = -PWM_MAX_VALUE;

    int dtTicks = (DEAD_TIME_US * freqHz * PWM_MAX_VALUE) / 1000000;
    int newPwm1 = 0, newPwm2 = 0;

    if (dutyBipolar >= 0) {
        newPwm1 = (int)dutyBipolar;
        if (newPwm1 > 0 && newPwm1 < dtTicks) newPwm1 = 0;
    } else {
        newPwm2 = (int)(-dutyBipolar);
        if (newPwm2 > 0 && newPwm2 < dtTicks) newPwm2 = 0;
    }

    if (newPwm1 != lastPwm1 || newPwm2 != lastPwm2) {
        ledcWrite(pin1, newPwm1);
        ledcWrite(pin2, newPwm2);
        lastPwm1 = newPwm1;
        lastPwm2 = newPwm2;
    }
}

float calculateWaveformDuty(WaveformType mode, float ampPercent, float freqHz, unsigned long startUs) {
    if (mode == WAVE_OFF) return 0.0;
    float t   = (micros() - startUs) / 1000000.0;
    float amp = (ampPercent / 100.0) * PWM_MAX_VALUE;
    switch (mode) {
        case WAVE_STEP:     return amp;
        case WAVE_SQUARE:   return (fmod(t, 1.0 / freqHz) < (1.0 / freqHz) * 0.5) ? amp : -amp;
        case WAVE_SINE:     return amp * sin(2.0 * PI * freqHz * t);
        case WAVE_TRIANGLE: {
            float period = 1.0 / freqHz;
            float phase  = fmod(t, period) / period;
            if      (phase < 0.25) return  4.0 * amp * phase;
            else if (phase < 0.75) return  amp * (2.0 - 4.0 * phase);
            else                   return  amp * (-4.0 + 4.0 * phase);
        }
        default: return 0.0;
    }
}

float processHallSensor(int pin, float offset) {
    int raw = analogRead(pin);
    return ((float)raw - offset) / COUNTS_PER_GAUSS;
}

// Stop all output safely without touching waveformTask's scheduling.
// Sets both waveforms to WAVE_OFF under the mux so waveformTask writes
// zero duty on its very next tick (<=50us at 20kHz), then forces the
// LEDC registers to zero immediately so there is no residual pulse.
void stopAllOutput() {
    portENTER_CRITICAL(&paramMux);
    helmWaveform = WAVE_OFF;
    elecWaveform = WAVE_OFF;
    portEXIT_CRITICAL(&paramMux);
    // Force immediate zero and sync the last-state shadow variables so that
    // waveformTask's change-detect (newPwm == lastPwm) sees no difference
    // on its next tick and does not re-write the LEDC registers.  Without
    // this, measureGaussAtPwm's seed of lastHelmPwm1=pwmVal is immediately
    // undone because waveformTask computes newPwm1=0 != lastHelmPwm1=pwmVal.
    ledcWrite(HELM_IN1_PIN, 0); ledcWrite(HELM_IN2_PIN, 0);
    ledcWrite(ELEC_IN1_PIN, 0); ledcWrite(ELEC_IN2_PIN, 0);
    lastHelmPwm1 = 0; lastHelmPwm2 = 0;
    lastElecPwm1 = 0; lastElecPwm2 = 0;
}

void autoZero(int samples = 600) {
    // Do NOT suspend waveformTask. Suspending a task that is registered
    // (or auto-registered) with the TWDT causes "task not found" spam
    // because the suspended task can no longer reset the watchdog.
    // Instead, signal WAVE_OFF through the mux and zero the outputs
    // directly — waveformTask keeps running and writing zero harmlessly.
    stopAllOutput();
    delay(100); // let any residual field decay

    long sum1 = 0, sum2 = 0;
    for (int i = 0; i < samples; i++) {
        sum1 += analogRead(HE1_PIN);
        sum2 += analogRead(HE2_PIN);
        delayMicroseconds(200);
    }
    he1ZeroOffset = (float)sum1 / samples;
    he2ZeroOffset = (float)sum2 / samples;

    Serial.println("--- Auto-Zero Complete ---");
    Serial.print("HE1 Offset Counts: "); Serial.println(he1ZeroOffset);
    Serial.print("HE2 Offset Counts: "); Serial.println(he2ZeroOffset);
}

// --- Calibration Helpers ---
float measureGaussAtPwm(float pwmPercent) {
    int pwmVal = (int)((pwmPercent / 100.0) * PWM_MAX_VALUE);

    // Actively hold IN2=0 while writing IN1=pwmVal, matching exactly what
    // waveformTask does via applyBipolarPWM — some H-bridge drivers float
    // or disable if IN2 is not being continuously driven.
    ledcWrite(HELM_IN2_PIN, 0);
    ledcWrite(HELM_IN1_PIN, pwmVal);
    lastHelmPwm1 = pwmVal;
    lastHelmPwm2 = 0;

    Serial.print("CAL_PWM pct="); Serial.print(pwmPercent);
    Serial.print(" pwmVal="); Serial.print(pwmVal);
    Serial.print(" IN1="); Serial.print(pwmVal);
    Serial.println(" IN2=0");

    // Re-assert both pins every 10ms during settle so IN2 never floats
    int settleMs = 1200;
    for (int t = 0; t < settleMs; t += 10) {
        ledcWrite(HELM_IN2_PIN, 0);
        ledcWrite(HELM_IN1_PIN, pwmVal);
        delay(10);
    }

    long sum1 = 0;
    for (int i = 0; i < 400; i++) {
        // Keep driving the coil during sampling
        ledcWrite(HELM_IN2_PIN, 0);
        ledcWrite(HELM_IN1_PIN, pwmVal);
        sum1 += analogRead(HE1_PIN);
        delayMicroseconds(500);
    }

    float rawAvg = (float)sum1 / 400;
    float gauss  = (rawAvg - he1ZeroOffset) / COUNTS_PER_GAUSS;

    Serial.print("CAL_ADC rawAvg="); Serial.print(rawAvg, 1);
    Serial.print(" zero="); Serial.print(he1ZeroOffset, 1);
    Serial.print(" delta="); Serial.print(rawAvg - he1ZeroOffset, 1);
    Serial.print(" gauss="); Serial.println(gauss, 3);

    return gauss;
}

void calibrateMagneticLut() {
    // Do NOT suspend waveformTask — see autoZero() comment above.
    // stopAllOutput() sets WAVE_OFF so waveformTask writes zero duty,
    // then measureGaussAtPwm() drives the coil directly via ledcWrite.
    stopAllOutput();
    isCalibrating = true;

    ledcWrite(ELEC_IN1_PIN, 0); ledcWrite(ELEC_IN2_PIN, 0);
    Serial.println("CAL_START");

    int numPoints = 0;
    for (int i = 0; i <= 20; i++) {
        float pct = i * 5.0;
        calPoints[numPoints].pwm   = pct;
        calPoints[numPoints].gauss = measureGaussAtPwm(pct);
        numPoints++;
        Serial.print("CAL_PT ");
        Serial.print(pct);
        Serial.print(" ");
        Serial.println(calPoints[numPoints-1].gauss, 3);
    }

    // Find the peak Gauss in the coarse sweep and truncate there.
    // Past the peak the curve rolls over (saturation / driver headroom),
    // making the PWM→Gauss relationship non-monotonic and non-invertible.
    // Refinement below the peak catches the real gaps (60–80% region);
    // without truncation the algorithm wastes iterations on the flat plateau.
    int peakIdx = 0;
    for (int i = 1; i < numPoints; i++) {
        if (calPoints[i].gauss > calPoints[peakIdx].gauss) peakIdx = i;
    }
    if (peakIdx < numPoints - 1) {
        numPoints = peakIdx + 1;
        Serial.print("CAL_PEAK pwm="); Serial.print(calPoints[peakIdx].pwm);
        Serial.print(" gauss="); Serial.println(calPoints[peakIdx].gauss, 3);
        Serial.println("CAL_TRUNCATED (plateau/rolloff discarded)");
    }

    // Refine until all jumps < 2.0 Gauss, within the monotonic region only
    bool needsRefinement = true;
    while (needsRefinement && numPoints < 200) {
        needsRefinement = false;
        int insertIdx = -1;
        float maxDiff = 0;

        for (int i = 0; i < numPoints-1; i++) {
            float diff = abs(calPoints[i+1].gauss - calPoints[i].gauss);
            if (diff >= 2.0 && diff > maxDiff) {
                maxDiff = diff;
                insertIdx = i;
                needsRefinement = true;
            }
        }

        if (needsRefinement && insertIdx != -1) {
            float midPwm   = (calPoints[insertIdx].pwm   + calPoints[insertIdx+1].pwm)   / 2.0;
            float midGauss = measureGaussAtPwm(midPwm);

            for (int i = numPoints; i > insertIdx+1; i--) {
                calPoints[i] = calPoints[i-1];
            }
            calPoints[insertIdx+1].pwm   = midPwm;
            calPoints[insertIdx+1].gauss = midGauss;
            numPoints++;

            Serial.print("CAL_PT ");
            Serial.print(midPwm);
            Serial.print(" ");
            Serial.println(midGauss, 3);
        }
    }

    // Interpolate to 0.1% increments (1001 points).
    // LUT only covers 0 → peak PWM%; entries beyond that are clamped to peak Gauss.
    float peakPwm   = calPoints[numPoints-1].pwm;
    float peakGauss = calPoints[numPoints-1].gauss;

    for (int i = 0; i <= 1000; i++) {
        float targetPwm = i / 10.0;
        if (targetPwm >= peakPwm) {
            helmLut[i] = peakGauss;
            continue;
        }
        int left = 0, right = numPoints - 1;
        for (int j = 0; j < numPoints - 1; j++) {
            if (calPoints[j].pwm <= targetPwm && calPoints[j+1].pwm >= targetPwm) {
                left = j; right = j+1; break;
            }
        }
        float pwmRange   = calPoints[right].pwm  - calPoints[left].pwm;
        float gaussRange = calPoints[right].gauss - calPoints[left].gauss;
        float ratio = (pwmRange == 0) ? 0 : (targetPwm - calPoints[left].pwm) / pwmRange;
        helmLut[i] = calPoints[left].gauss + ratio * gaussRange;
    }

    lutCalibrated = true;

    Serial.print("CAL_LUT ");
    for (int i = 0; i <= 1000; i++) {
        Serial.print(helmLut[i], 3);
        if (i < 1000) Serial.print(",");
    }
    Serial.println();
    Serial.flush();
    Serial.println("CAL_END");
    Serial.flush();

    // Return coil to zero via the mux path so waveformTask's state is clean.
    portENTER_CRITICAL(&paramMux);
    helmWaveform = WAVE_OFF;
    portEXIT_CRITICAL(&paramMux);
    ledcWrite(HELM_IN1_PIN, 0); ledcWrite(HELM_IN2_PIN, 0);
    lastHelmPwm1 = 0; lastHelmPwm2 = 0;

    isCalibrating = false;
}

void calibrationTask(void *pv) {
    calibrateMagneticLut();
    calTaskHandle = NULL;
    vTaskDelete(NULL);
}

// ==============================================================================
// ===================== WAVEFORM TASK (Core 0) =================================
// ==============================================================================
void waveformTask(void *pv) {
    unsigned long helmPrev = micros();
    unsigned long elecPrev = micros();
    for (;;) {
        unsigned long nowUs = micros();
        if (nowUs - helmPrev >= HELM_SAMPLE_INTERVAL_US) {
            helmPrev = nowUs;
            WaveformType m; float amp, freq; unsigned long startUs;
            portENTER_CRITICAL(&paramMux);
            m = helmWaveform; amp = helmAmpPercent; freq = helmFreqHz; startUs = helmWaveStartUs;
            portEXIT_CRITICAL(&paramMux);
            float duty = calculateWaveformDuty(m, amp, freq, startUs);
            applyBipolarPWM(HELM_IN1_PIN, HELM_IN2_PIN, duty, lastHelmPwm1, lastHelmPwm2, HELM_PWM_FREQ_HZ);
        }
        if (nowUs - elecPrev >= ELEC_SAMPLE_INTERVAL_US) {
            elecPrev = nowUs;
            WaveformType m; float amp, freq; unsigned long startUs;
            portENTER_CRITICAL(&paramMux);
            m = elecWaveform; amp = elecAmpPercent; freq = elecFreqHz; startUs = elecWaveStartUs;
            portEXIT_CRITICAL(&paramMux);
            float duty = calculateWaveformDuty(m, amp, freq, startUs);
            applyBipolarPWM(ELEC_IN1_PIN, ELEC_IN2_PIN, duty, lastElecPwm1, lastElecPwm2, ELEC_PWM_FREQ_HZ);
        }
    }
}

// ==============================================================================
// ============================== SETUP =========================================
// ==============================================================================
void setup() {
    Serial.setTxBufferSize(8192);
    Serial.begin(500000);
    delay(500);

    disableCore0WDT();
    disableCore1WDT();

    analogSetPinAttenuation(HE1_PIN, ADC_11db);
    analogSetPinAttenuation(HE2_PIN, ADC_11db);
    ledcAttach(HELM_IN1_PIN, HELM_PWM_FREQ_HZ, PWM_RESOLUTION_BITS);
    ledcAttach(HELM_IN2_PIN, HELM_PWM_FREQ_HZ, PWM_RESOLUTION_BITS);
    ledcAttach(ELEC_IN1_PIN, ELEC_PWM_FREQ_HZ, PWM_RESOLUTION_BITS);
    ledcAttach(ELEC_IN2_PIN, ELEC_PWM_FREQ_HZ, PWM_RESOLUTION_BITS);
    ledcWrite(HELM_IN1_PIN, 0); ledcWrite(HELM_IN2_PIN, 0);
    ledcWrite(ELEC_IN1_PIN, 0); ledcWrite(ELEC_IN2_PIN, 0);

    Serial.println("=== ESP32 Helmholtz/Electrode Driver Ready ===");
    Serial.println("Running auto-zero calibration...");
    autoZero();

    unsigned long now = micros();
    helmWaveStartUs = now; elecWaveStartUs = now; prevHeSampleUs = now;

    xTaskCreatePinnedToCore(waveformTask, "waveform", 4096, NULL, 10, &waveTaskHandle, 0);

    Serial.println("Commands:");
    Serial.println("  h <mode> <amp%> <freq>   - set Helmholtz channel");
    Serial.println("  e <mode> <amp%> <freq>   - set Electrode channel");
    Serial.println("  z                        - re-run auto-zero calibration");
    Serial.println("  c                        - run magnetic field calibration");
    Serial.println("  Modes: 0=OFF 1=STEP 2=SQUARE 3=SINE 4=TRIANGLE");
}

// ==============================================================================
// ============================== MAIN LOOP (Core 1) ============================
// ==============================================================================
void handleCommand(String line) {
    line.trim();
    if (line.length() == 0) return;
    char target = line.charAt(0);

    if (target == 'z' || target == 'Z') {
        autoZero();
        prevHeSampleUs = micros();
        return;
    }

    if (target == 'c' || target == 'C') {
        if (calTaskHandle != NULL) {
            Serial.println("CAL_BUSY");
            return;
        }
        xTaskCreatePinnedToCore(
            calibrationTask,
            "calibration",
            8192,
            NULL,
            5,
            &calTaskHandle,
            1
        );
        return;
    }

    int spaceIdx = line.indexOf(' ');
    if (spaceIdx == -1) return;
    String params = line.substring(spaceIdx + 1);
    int mode = (int)params.toFloat();
    float amp = 0.0, freq = 0.0;
    int sp2 = params.indexOf(' ');
    if (sp2 != -1) {
        String rest = params.substring(sp2 + 1);
        amp = rest.toFloat();
        int sp3 = rest.indexOf(' ');
        if (sp3 != -1) freq = rest.substring(sp3 + 1).toFloat();
    }
    unsigned long startUs = micros();

    if (target == 'h' || target == 'H') {
        portENTER_CRITICAL(&paramMux);
        helmWaveform = (WaveformType)mode;
        if (amp >= 0.0 && amp <= 100.0) helmAmpPercent = amp;
        if (freq >= HELM_MIN_FREQ_HZ && freq <= HELM_MAX_FREQ_HZ) helmFreqHz = freq;
        helmWaveStartUs = startUs;
        portEXIT_CRITICAL(&paramMux);
        Serial.print("Helmholtz SET -> mode="); Serial.print((int)helmWaveform);
        Serial.print(" amp="); Serial.print(helmAmpPercent);
        Serial.print("% freq="); Serial.println(helmFreqHz);
    } else if (target == 'e' || target == 'E') {
        portENTER_CRITICAL(&paramMux);
        elecWaveform = (WaveformType)mode;
        if (amp >= 0.0 && amp <= 100.0) elecAmpPercent = amp;
        if (freq >= ELEC_MIN_FREQ_HZ && freq <= ELEC_MAX_FREQ_HZ) elecFreqHz = freq;
        elecWaveStartUs = startUs;
        portEXIT_CRITICAL(&paramMux);
        Serial.print("Electrode SET -> mode="); Serial.print((int)elecWaveform);
        Serial.print(" amp="); Serial.print(elecAmpPercent);
        Serial.print("% freq="); Serial.println(elecFreqHz);
    }
}

void loop() {
    unsigned long nowUs = micros();
    if (nowUs - prevHeSampleUs >= HE_SAMPLE_INTERVAL_US) {
        prevHeSampleUs = nowUs;

        if (!isCalibrating) {
            float he1Inst = processHallSensor(HE1_PIN, he1ZeroOffset);
            float he2Inst = processHallSensor(HE2_PIN, he2ZeroOffset);
            if (Serial.availableForWrite() >= 24) {
                Serial.print(he1Inst, 2);
                Serial.print(' ');
                Serial.println(he2Inst, 2);
            }
        }
    }

    static char cmdBuf[64];
    static int cmdLen = 0;
    while (Serial.available()) {
        char c = Serial.read();
        if (c == '\n' || c == '\r') {
            if (cmdLen > 0) {
                cmdBuf[cmdLen] = '\0';
                handleCommand(String(cmdBuf));
                cmdLen = 0;
            }
        } else if (cmdLen < (int)sizeof(cmdBuf) - 1) {
            cmdBuf[cmdLen++] = c;
        } else {
            cmdLen = 0;
        }
    }
}
