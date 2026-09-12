-- ====================================================================
-- Database Schema for WhatsApp ERP (Cloud Run + Fabkraft Integration)
-- All tables use the 'wh_' prefix as requested.
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Main Uploads Tracking Table
-- Stores metadata for every media/image uploaded to fabkraft.in
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wh_uploads` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `receiver_mobile` VARCHAR(25) NOT NULL COMMENT 'On which mobile image has been sent (QR Code WhatsApp Bot Number)',
    `sender_mobile` VARCHAR(25) NOT NULL COMMENT 'Mobile number that sent the image',
    `image_caption` VARCHAR(100) DEFAULT NULL COMMENT 'Caption/Document Type (e.g., Aadhaar Card, PAN Card)',
    `image_id` VARCHAR(100) DEFAULT NULL COMMENT 'Extracted ID Number (e.g., Aadhaar Number, PAN Number)',
    `upload_uri` VARCHAR(500) NOT NULL COMMENT 'Target URL on fabkraft.in/WhatsAppFolder/uploads/',
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_sender_mobile` (`sender_mobile`),
    INDEX `idx_receiver_mobile` (`receiver_mobile`),
    INDEX `idx_image_id` (`image_id`),
    INDEX `idx_image_caption` (`image_caption`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 2. Aadhaar Detailed Records Table
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wh_aadhar_records` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `upload_id` INT DEFAULT NULL COMMENT 'Reference to wh_uploads.id',
    `aadhar_number` VARCHAR(20) NOT NULL UNIQUE COMMENT '12-digit Aadhaar Number',
    `virtual_id` VARCHAR(25) DEFAULT NULL COMMENT '16-digit VID',
    `name_english` VARCHAR(255) DEFAULT NULL,
    `name_hindi` VARCHAR(255) DEFAULT NULL,
    `dob` VARCHAR(20) DEFAULT NULL COMMENT 'DOB or YOB (DD/MM/YYYY or YYYY)',
    `gender_english` VARCHAR(20) DEFAULT NULL,
    `gender_hindi` VARCHAR(50) DEFAULT NULL,
    `relation_status` VARCHAR(50) DEFAULT NULL COMMENT 'W/O, S/O, D/O, or C/O',
    `father_name_english` VARCHAR(255) DEFAULT NULL,
    `father_name_hindi` VARCHAR(255) DEFAULT NULL,
    `husband_name_english` VARCHAR(255) DEFAULT NULL,
    `husband_name_hindi` VARCHAR(255) DEFAULT NULL,
    `address_english` TEXT DEFAULT NULL,
    `address_hindi` TEXT DEFAULT NULL,
    `pincode` VARCHAR(10) DEFAULT NULL,
    `raw_json` LONGTEXT DEFAULT NULL COMMENT 'Complete extracted aadhaar_card_data JSON',
    `tokens_prompt` INT DEFAULT 0,
    `tokens_completion` INT DEFAULT 0,
    `tokens_total` INT DEFAULT 0,
    `ai_model` VARCHAR(100) DEFAULT NULL,
    `accuracy_overall` INT DEFAULT 100,
    `accuracy_aadhaar_number` INT DEFAULT 100,
    `accuracy_name_english` INT DEFAULT 100,
    `accuracy_name_hindi` INT DEFAULT 100,
    `accuracy_dob` INT DEFAULT 100,
    `accuracy_pincode` INT DEFAULT 100,
    `sender_mobile` VARCHAR(25) NOT NULL,
    `receiver_mobile` VARCHAR(25) NOT NULL,
    `front_image_uri` VARCHAR(500) DEFAULT NULL,
    `back_image_uri` VARCHAR(500) DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_aadhar_number` (`aadhar_number`),
    INDEX `idx_sender_mobile` (`sender_mobile`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 3. PAN Detailed Records Table
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wh_pan_records` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `upload_id` INT DEFAULT NULL COMMENT 'Reference to wh_uploads.id',
    `pan_number` VARCHAR(20) NOT NULL UNIQUE COMMENT '10-character Alphanumeric PAN',
    `name` VARCHAR(255) DEFAULT NULL,
    `father_name` VARCHAR(255) DEFAULT NULL,
    `dob` VARCHAR(20) DEFAULT NULL,
    `sender_mobile` VARCHAR(25) NOT NULL,
    `receiver_mobile` VARCHAR(25) NOT NULL,
    `image_uri` VARCHAR(500) DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_pan_number` (`pan_number`),
    INDEX `idx_sender_mobile` (`sender_mobile`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 4. WhatsApp Session Auth State Table (For Cloud Run persistence)
-- Stores Baileys credentials and encryption keys in MySQL
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wh_baileys_auth` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY,
    `value` LONGTEXT NOT NULL,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

