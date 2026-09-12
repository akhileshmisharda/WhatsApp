/**
 * Phonetic Transliteration Utility for Indian Names (English <-> Hindi Devanagari)
 */

const ENG_TO_HIN_VOWELS = {
    'aa': 'ा', 'ai': 'ै', 'au': 'ौ', 'ee': 'ी', 'oo': 'ू',
    'a': '', 'i': 'ि', 'u': 'ु', 'e': 'े', 'o': 'ो'
};

const ENG_TO_HIN_INITIAL_VOWELS = {
    'aa': 'आ', 'ai': 'ऐ', 'au': 'औ', 'ee': 'ई', 'oo': 'ऊ',
    'a': 'अ', 'i': 'इ', 'u': 'उ', 'e': 'ए', 'o': 'ओ'
};

const ENG_TO_HIN_CONSONANTS = {
    'bh': 'भ', 'ch': 'च', 'chh': 'छ', 'dh': 'ध', 'gh': 'घ',
    'jh': 'झ', 'kh': 'ख', 'ph': 'फ', 'sh': 'श', 'th': 'थ',
    'shh': 'ष', 'zh': 'झ',
    'b': 'ब', 'c': 'क', 'd': 'द', 'f': 'फ़', 'g': 'ग',
    'h': 'ह', 'j': 'ज', 'k': 'क', 'l': 'ल', 'm': 'म',
    'n': 'न', 'p': 'प', 'q': 'क', 'r': 'र', 's': 'स',
    't': 'त', 'v': 'व', 'w': 'व', 'x': 'क्स', 'y': 'य', 'z': 'ज़'
};

const HIN_TO_ENG_MAP = {
    'अ': 'A', 'आ': 'Aa', 'इ': 'I', 'ई': 'Ee', 'उ': 'U', 'ऊ': 'Oo', 'ए': 'E', 'ऐ': 'Ai', 'ओ': 'O', 'औ': 'Au',
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
    'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', '्': '',
    'ं': 'n', 'ँ': 'n', 'ः': 'h', '़': ''
};

// Common Indian Name Dictionary for 100% accurate standard names
const COMMON_NAMES = {
    'akhilesh': 'अखिलेश',
    'brij': 'बृज',
    'mohan': 'मोहन',
    'mittal': 'मित्तल',
    'ramesh': 'रमेश',
    'kumar': 'कुमार',
    'sharma': 'शर्मा',
    'verma': 'वर्मा',
    'singh': 'सिंह',
    'gupta': 'गुप्ता',
    'agrawal': 'अग्रवाल',
    'agarwal': 'अग्रवाल',
    'jain': 'जैन',
    'patel': 'पटेल',
    'suresh': 'सुरेश',
    'mahesh': 'महेश',
    'dinesh': 'दिनेश',
    'mukesh': 'मुकेश',
    'rajesh': 'राजेश',
    'rakesh': 'राकेश',
    'sunil': 'सुनील',
    'anil': 'अनिल',
    'vijay': 'विजय',
    'ajay': 'अजय',
    'sanjay': 'संजय',
    'pankaj': 'पंकज',
    'manoj': 'मनोज',
    'vinod': 'विनोद',
    'ashok': 'अशोक',
    'deepak': 'दीपक',
    'pradeep': 'प्रदीप',
    'sandeep': 'संदीप',
    'kuldeep': 'कुलदीप',
    'amit': 'अमित',
    'sumit': 'सुमित',
    'rohit': 'रोहित',
    'mohit': 'मोहित',
    'rahul': 'राहुल',
    'vikas': 'विकास',
    'vishal': 'विशाल',
    'sachin': 'सचिन',
    'nitin': 'नितिन',
    'praveen': 'प्रवीण',
    'naveen': 'नवीन',
    'sunita': 'सुनीता',
    'anita': 'अनीता',
    'geeta': 'गीता',
    'seema': 'सीमा',
    'rekha': 'रेखा',
    'pooja': 'पूजा',
    'neha': 'नेहा',
    'priya': 'प्रिया',
    'sharda': 'शारदा',
    'devi': 'देवी',
    'lal': 'लाल',
    'chand': 'चंद',
    'chandra': 'चंद्र',
    'prasad': 'प्रसाद',
    'nath': 'नाथ',
    'swaroop': 'स्वरूप',
    'kishore': 'किशोर',
    'gopal': 'गोपाल',
    'govind': 'गोविंद',
    'harish': 'हरीश',
    'om': 'ओम',
    'prakash': 'प्रकाश',
    'shanti': 'शांति',
    'radha': 'राधा',
    'krishna': 'कृष्ण',
    'shyam': 'श्याम'
};

const REVERSE_COMMON_NAMES = {};
for (const [eng, hin] of Object.entries(COMMON_NAMES)) {
    REVERSE_COMMON_NAMES[hin] = eng.charAt(0).toUpperCase() + eng.slice(1);
}

/**
 * Transliterates an English name string to Hindi Devanagari
 */
function transliterateEnglishToHindi(name) {
    if (!name || name === "Not Found") return "";
    const words = name.trim().split(/\s+/);
    const convertedWords = words.map(word => {
        const lower = word.toLowerCase().replace(/[^a-z]/g, "");
        if (COMMON_NAMES[lower]) {
            return COMMON_NAMES[lower];
        }

        // Algorithmic Phonetic Fallback
        let result = "";
        let i = 0;
        const len = word.length;
        let isStart = true;

        while (i < len) {
            const char3 = word.substring(i, i + 3).toLowerCase();
            const char2 = word.substring(i, i + 2).toLowerCase();
            const char1 = word.substring(i, i + 1).toLowerCase();

            if (isStart && ENG_TO_HIN_INITIAL_VOWELS[char2]) {
                result += ENG_TO_HIN_INITIAL_VOWELS[char2];
                i += 2;
                isStart = false;
                continue;
            } else if (isStart && ENG_TO_HIN_INITIAL_VOWELS[char1]) {
                result += ENG_TO_HIN_INITIAL_VOWELS[char1];
                i += 1;
                isStart = false;
                continue;
            }

            if (ENG_TO_HIN_CONSONANTS[char3]) {
                result += ENG_TO_HIN_CONSONANTS[char3];
                i += 3;
                isStart = false;
            } else if (ENG_TO_HIN_CONSONANTS[char2]) {
                result += ENG_TO_HIN_CONSONANTS[char2];
                i += 2;
                isStart = false;
            } else if (ENG_TO_HIN_CONSONANTS[char1]) {
                result += ENG_TO_HIN_CONSONANTS[char1];
                i += 1;
                isStart = false;
            } else if (ENG_TO_HIN_VOWELS[char2] !== undefined) {
                result += ENG_TO_HIN_VOWELS[char2];
                i += 2;
            } else if (ENG_TO_HIN_VOWELS[char1] !== undefined) {
                result += ENG_TO_HIN_VOWELS[char1];
                i += 1;
            } else {
                result += word[i];
                i++;
            }
        }
        return result;
    });

    return convertedWords.join(" ");
}

/**
 * Transliterates a Hindi Devanagari name string to English
 */
function transliterateHindiToEnglish(name) {
    if (!name || name === "Not Found") return "";
    const words = name.trim().split(/\s+/);
    const convertedWords = words.map(word => {
        if (REVERSE_COMMON_NAMES[word]) {
            return REVERSE_COMMON_NAMES[word];
        }

        let result = "";
        for (let i = 0; i < word.length; i++) {
            const ch = word[i];
            if (HIN_TO_ENG_MAP[ch]) {
                result += HIN_TO_ENG_MAP[ch];
            }
        }
        return result.charAt(0).toUpperCase() + result.slice(1);
    });

    return convertedWords.join(" ");
}

/**
 * Ensures both English and Hindi versions exist for a given name field
 */
function ensureBilingualName(nameEng, nameHin) {
    let eng = (nameEng && nameEng !== "Not Found" && nameEng.trim() !== "") ? nameEng.trim() : "";
    let hin = (nameHin && nameHin !== "Not Found" && nameHin.trim() !== "") ? nameHin.trim() : "";

    if (eng && !hin) {
        hin = transliterateEnglishToHindi(eng);
    } else if (hin && !eng) {
        eng = transliterateHindiToEnglish(hin);
    }

    return {
        english: eng || "Not Found",
        hindi: hin || "Not Found"
    };
}

module.exports = {
    transliterateEnglishToHindi,
    transliterateHindiToEnglish,
    ensureBilingualName
};
