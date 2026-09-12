<?php
/**
 * Fabkraft WhatsApp Upload Handler
 * Place this file on your GoDaddy server at:
 * https://fabkraft.in/WhatsAppFolder/upload.php
 * 
 * It will receive image uploads from Cloud Run and save them to:
 * https://fabkraft.in/WhatsAppFolder/uploads/
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// 1. Define upload directories
$baseUploadDir = __DIR__ . '/uploads/';

if (!file_exists($baseUploadDir)) {
    mkdir($baseUploadDir, 0755, true);
}

// Subdirectories by document category
$subDir = isset($_POST['category']) ? preg_replace('/[^a-zA-Z0-9_-]/', '', $_POST['category']) : 'general';
$targetDir = $baseUploadDir . $subDir . '/';

if (!file_exists($targetDir)) {
    mkdir($targetDir, 0755, true);
}

// 2. Validate incoming file
if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    http_response_code(400);
    echo json_encode([
        'status' => 'error',
        'message' => 'No file uploaded or upload error occurred.'
    ]);
    exit();
}

$file = $_FILES['file'];
$fileName = isset($_POST['fileName']) ? basename($_POST['fileName']) : basename($file['name']);

// Sanitize filename
$fileName = preg_replace('/[^a-zA-Z0-9_\.-]/', '_', $fileName);
$targetFilePath = $targetDir . $fileName;

// 3. Move uploaded file
if (move_uploaded_file($file['tmp_name'], $targetFilePath)) {
    // Generate public URI
    $protocol = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' || $_SERVER['SERVER_PORT'] == 443) ? "https://" : "http://";
    $host = $_SERVER['HTTP_HOST'];
    $uploadUri = $protocol . $host . '/WhatsAppFolder/uploads/' . ($subDir ? $subDir . '/' : '') . $fileName;

    http_response_code(200);
    echo json_encode([
        'status' => 'success',
        'message' => 'File uploaded successfully',
        'fileName' => $fileName,
        'upload_uri' => $uploadUri,
        'size' => $file['size']
    ]);
} else {
    http_response_code(500);
    echo json_encode([
        'status' => 'error',
        'message' => 'Failed to move uploaded file to target directory.'
    ]);
}
?>

