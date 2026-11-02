"use strict";

const CHUNK_SIZE = 16 * 1024;

const peerConfig = {
    config: {
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" }
        ]
    },
    debug: 1
};

let peer = null;
let selectedFile = null;
const studentConnections = new Map();

let receivedChunks = [];
let receivedBytes = 0;
let expectedBytes = 0;

let currentFileName = "";
let currentMimeType = "application/octet-stream";
let downloadUrl = null;

let qrStream = null;
let qrScanning = false;
let barcodeDetector = null;

const $ = id => document.getElementById(id);

const roleSection = $("roleSection");
const teacherSection = $("teacherSection");
const studentSection = $("studentSection");

const fileInput = $("fileInput");
const teacherId = $("teacherId");
const teacherLog = $("teacherLog");

const studentCount = $("studentCount");
const completedCount = $("completedCount");

const teacherIdInput = $("teacherIdInput");
const studentStatus = $("studentStatus");

const progressArea = $("progressArea");
const progressBar = $("progressBar");
const progressText = $("progressText");

const downloadArea = $("downloadArea");

function showSection(section) {
    roleSection.classList.add("hidden");
    teacherSection.classList.add("hidden");
    studentSection.classList.add("hidden");
    section.classList.remove("hidden");
}

function logMessage(message) {
    const time = new Date().toLocaleTimeString("tr-TR");
    const div = document.createElement("div");
    div.textContent = `[${time}] ${message}`;
    teacherLog.appendChild(div);
    teacherLog.scrollTop = teacherLog.scrollHeight;
}

function updateStudentCount() {
    studentCount.textContent = studentConnections.size;
}

function updateCompletedCount() {
    let count = 0;

    studentConnections.forEach(student => {
        if (student.completed) count++;
    });

    completedCount.textContent = count;
}

function readBlob(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Dosya okunamadı."));
        reader.readAsArrayBuffer(blob);
    });
}
function waitForBuffer(connection) {
    return new Promise((resolve, reject) => {
        const channel = connection.dataChannel;

        if (!channel || channel.readyState !== "open") {
            reject(new Error("Veri kanalı kapandı."));
            return;
        }

        if (channel.bufferedAmount < 1024 * 1024) {
            resolve();
            return;
        }

        const timeout = setTimeout(() => {
            reject(new Error("Gönderim zaman aşımı."));
        }, 60000);

        function onLow() {
            clearTimeout(timeout);
            channel.removeEventListener("bufferedamountlow", onLow);
            resolve();
        }

        channel.bufferedAmountLowThreshold = 512 * 1024;
        channel.addEventListener("bufferedamountlow", onLow);
    });
}

// ==========================================
// ROL SEÇİMİ
// ==========================================

$("teacherRole").addEventListener("click", () => {
    showSection(teacherSection);
});

$("studentRole").addEventListener("click", () => {
    showSection(studentSection);

    const isMobile =
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
        (navigator.maxTouchPoints > 1 && window.innerWidth <= 900);

    $("qrArea").classList.toggle("hidden", !isMobile);
});

// ==========================================
// HOCA MODU
// ==========================================

fileInput.addEventListener("change", event => {
    const file = event.target.files[0];

    if (!file) return;

    selectedFile = file;
    startTeacher();
});

function startTeacher() {
    if (!selectedFile) return;

    if (peer) {
        peer.destroy();
    }

    studentConnections.clear();

    updateStudentCount();
    updateCompletedCount();

    $("teacherConnection").classList.remove("hidden");
    teacherLog.textContent = "";

    logMessage("Hoca bağlantısı hazırlanıyor...");

    peer = new Peer(undefined, peerConfig);

    peer.on("open", id => {
        teacherId.textContent = id;

        logMessage("Hoca bağlantısı hazır.");

        const qrContainer = $("qrcode");
        qrContainer.innerHTML = "";

        const qrData = new URL(window.location.href);
        qrData.searchParams.set("teacher", id);

        new QRCode(qrContainer, {
            text: qrData.toString(),
            width: 220,
            height: 220,
            correctLevel: QRCode.CorrectLevel.M
        });

        logMessage("QR kod oluşturuldu.");
    });

    peer.on("connection", connection => {
        const id = connection.peer;

        const student = {
            connection,
            progress: 0,
            completed: false,
            sending: false
        };

        studentConnections.set(id, student);
        updateStudentCount();

        logMessage("Öğrenci bağlandı: " + id);

        connection.on("open", async () => {
            if (student.sending) return;

            student.sending = true;

            try {
                logMessage("Dosya gönderimi başladı: " + id);

                await sendFile(connection, student);

                student.completed = true;
                updateCompletedCount();

                logMessage("Transfer tamamlandı: " + id);

            } catch (error) {
                logMessage("Transfer hatası: " + error.message);
            }
        });

        connection.on("close", () => {
            logMessage("Bağlantı kapandı: " + id);
        });

        connection.on("error", error => {
            logMessage("Bağlantı hatası: " + error.message);
        });
    });

    peer.on("error", error => {
        logMessage("PeerJS hatası: " + error.message);
    });
}

// ==========================================
// DOSYA GÖNDERME
// ==========================================

async function sendFile(connection, student) {
    const file = selectedFile;

    if (!file) {
        throw new Error("Dosya seçilmedi.");
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    connection.send({
        type: "file-start",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        chunks: totalChunks
    });

    let sentBytes = 0;

    for (let i = 0; i < totalChunks; i++) {
        if (!connection.open) {
            throw new Error("Öğrenci bağlantısı kapandı.");
        }

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);

        const blob = file.slice(start, end);
        const buffer = await readBlob(blob);

        await waitForBuffer(connection);

        connection.send(buffer);

        sentBytes += buffer.byteLength;

        const percent = file.size === 0
            ? 100
            : Math.round(sentBytes / file.size * 100);

        student.progress = percent;

        logMessage(idText(student) + " - Transfer: %" + percent);
    }

    await waitForBuffer(connection);

    connection.send({
        type: "file-end"
    });

    student.progress = 100;
}

function idText(student) {
    return student.connection.peer;
}

// ==========================================
// ID KOPYALAMA
// ==========================================

$("copyId").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(teacherId.textContent);
        alert("Bağlantı ID'si kopyalandı.");
    } catch {
        alert("ID kopyalanamadı. Elle seçebilirsiniz.");
    }
});
$("connectButton").addEventListener("click", () => {
    const id = teacherIdInput.value.trim();

    if (!id) {
        alert("Lütfen hocanın ID'sini giriniz.");
        return;
    }

    connectToTeacher(id);
});

function connectToTeacher(id) {
    $("connectButton").disabled = true;

    studentStatus.textContent = "Bağlantı kuruluyor...";

    progressArea.classList.add("hidden");
    downloadArea.classList.add("hidden");

    receivedChunks = [];
    receivedBytes = 0;
    expectedBytes = 0;

    if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
        downloadUrl = null;
    }

    if (peer) {
        peer.destroy();
    }

    peer = new Peer(undefined, peerConfig);

    peer.on("open", () => {
        const connection = peer.connect(id, {
            reliable: true,
            serialization: "binary"
        });

        connection.on("open", () => {
            studentStatus.textContent =
                "Hocaya bağlanıldı. Dosya bekleniyor.";
        });

        connection.on("data", handleIncomingData);

        connection.on("close", () => {
            studentStatus.textContent = "Bağlantı kapandı.";
            $("connectButton").disabled = false;
        });

        connection.on("error", error => {
            studentStatus.textContent =
                "Bağlantı hatası: " + error.message;

            $("connectButton").disabled = false;
        });
    });

    peer.on("error", error => {
        studentStatus.textContent =
            "PeerJS hatası: " + error.message;

        $("connectButton").disabled = false;
    });
}

// ==========================================
// DOSYA ALMA
// ==========================================

function handleIncomingData(data) {

    // Dosya başlangıç bilgileri
    if (
        typeof data === "object" &&
        !(data instanceof ArrayBuffer) &&
        !(data instanceof Blob)
    ) {
        if (data.type === "file-start") {
            currentFileName = data.name;
            currentMimeType = data.mime;
            expectedBytes = data.size;

            receivedBytes = 0;
            receivedChunks = [];

            $("fileName").textContent =
                "Dosya: " + currentFileName;

            progressArea.classList.remove("hidden");
            downloadArea.classList.add("hidden");

            progressBar.value = 0;
            progressText.textContent = "%0";

            studentStatus.textContent =
                "Dosya transferi başladı.";
        }

        if (data.type === "file-end") {
            finishDownload();
        }

        return;
    }

    // ArrayBuffer parçaları
    if (data instanceof ArrayBuffer) {
        receivedChunks.push(data);
        receivedBytes += data.byteLength;

        updateProgress();
    }

    // Blob parçaları
    else if (data instanceof Blob) {
        data.arrayBuffer().then(buffer => {
            receivedChunks.push(buffer);
            receivedBytes += buffer.byteLength;

            updateProgress();
        }).catch(error => {
            studentStatus.textContent =
                "Parça okunamadı: " + error.message;
        });
    }
}

// ==========================================
// İLERLEME ÇUBUĞU
// ==========================================

function updateProgress() {
    const percent = expectedBytes === 0
        ? 100
        : Math.min(
            100,
            Math.round(receivedBytes / expectedBytes * 100)
        );

    progressBar.value = percent;
    progressText.textContent = "%" + percent;

    studentStatus.textContent =
        "Dosya alınıyor: %" + percent;
}

// ==========================================
// DOSYAYI BİRLEŞTİRME
// ==========================================

function finishDownload() {

    if (receivedBytes !== expectedBytes) {
        studentStatus.textContent =
            "Hata: Dosya eksik alındı.";

        return;
    }

    const fileBlob = new Blob(
        receivedChunks,
        { type: currentMimeType }
    );

    downloadUrl = URL.createObjectURL(fileBlob);

    progressBar.value = 100;
    progressText.textContent = "%100";

    progressArea.classList.remove("hidden");
    downloadArea.classList.remove("hidden");

    studentStatus.textContent =
        "Dosya başarıyla alındı.";

    receivedChunks = [];
}

// ==========================================
// DOSYA İNDİRME
// ==========================================

$("downloadButton").addEventListener("click", () => {

    if (!downloadUrl) return;

    const link = document.createElement("a");

    link.href = downloadUrl;
    link.download = currentFileName;

    document.body.appendChild(link);

    link.click();

    link.remove();
});
$("scanButton").addEventListener("click", startQRScanner);

async function startQRScanner() {

    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {
        $("qrStatus").textContent =
            "Kamera erişimi desteklenmiyor.";

        return;
    }

    if (!("BarcodeDetector" in window)) {
        $("qrStatus").textContent =
            "QR okuyucu desteklenmiyor. ID'yi elle giriniz.";

        return;
    }

    try {

        barcodeDetector = new BarcodeDetector({
            formats: ["qr_code"]
        });

        qrStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "environment"
            },
            audio: false
        });

        const video = $("qrVideo");

        video.srcObject = qrStream;
        video.classList.add("active");

        await video.play();

        qrScanning = true;

        $("qrStatus").textContent =
            "QR kod kameraya gösteriniz.";

        scanQRFrame();

    } catch (error) {

        $("qrStatus").textContent =
            "Kamera açılamadı: " + error.message;

    }
}

async function scanQRFrame() {

    if (!qrScanning) return;

    try {

        const video = $("qrVideo");

        if (video.readyState >= 2) {

            const codes = await barcodeDetector.detect(video);

            if (codes.length > 0) {

                const result = codes[0].rawValue;

                let id = result;

                try {
                    const url = new URL(result);

                    id = url.searchParams.get("teacher") || result;

                } catch (error) {
                    // QR doğrudan ID içeriyorsa kullan.
                }

                teacherIdInput.value = id;

                stopQRScanner();

                $("qrStatus").textContent =
                    "QR kod başarıyla okundu.";

                connectToTeacher(id);

                return;
            }
        }

    } catch (error) {

        console.error("QR tarama hatası:", error);

    }

    requestAnimationFrame(scanQRFrame);
}

// ==========================================
// KAMERA DURDURMA
// ==========================================

function stopQRScanner() {

    qrScanning = false;

    if (qrStream) {

        qrStream.getTracks().forEach(track => {
            track.stop();
        });

        qrStream = null;
    }

    $("qrVideo").srcObject = null;

    $("qrVideo").classList.remove("active");
}

// ==========================================
// TEMİZLEME
// ==========================================

function cleanup() {

    stopQRScanner();

    if (peer) {
        peer.destroy();
        peer = null;
    }

    studentConnections.clear();

    selectedFile = null;

    receivedChunks = [];

    receivedBytes = 0;
    expectedBytes = 0;

    if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
        downloadUrl = null;
    }

    $("connectButton").disabled = false;

    fileInput.value = "";

    teacherId.textContent = "Bekleniyor...";

    teacherLog.textContent = "";

    $("teacherConnection").classList.add("hidden");

    $("qrcode").innerHTML = "";

    updateStudentCount();
    updateCompletedCount();
}

// ==========================================
// ANA MENÜYE DÖNÜŞ
// ==========================================

$("teacherBack").addEventListener("click", () => {

    cleanup();

    showSection(roleSection);

});

$("studentBack").addEventListener("click", () => {

    cleanup();

    showSection(roleSection);

});

// ==========================================
// QR LİNKİ İLE OTOMATİK AÇILIŞ
// ==========================================

window.addEventListener("load", () => {

    const params = new URLSearchParams(
        window.location.search
    );

    const teacher = params.get("teacher");

    if (teacher) {

        showSection(studentSection);

        teacherIdInput.value = teacher;

        const isMobile =
            /Android|iPhone|iPad|iPod|Mobile/i.test(
                navigator.userAgent
            );

        $("qrArea").classList.toggle(
            "hidden",
            !isMobile
        );
    }

});

// ==========================================
// SERVICE WORKER KAYDI
// ==========================================

if ("serviceWorker" in navigator) {

    window.addEventListener("load", () => {

        navigator.serviceWorker.register("./sw.js")

            .then(() => {
                console.log("Service Worker başarıyla kaydedildi.");
            })

            .catch(error => {
                console.error(
                    "Service Worker kayıt hatası:",
                    error
                );
            });

    });

}

console.log("ALŞ09 P2P uygulaması hazır.");