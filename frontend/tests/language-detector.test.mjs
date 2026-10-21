import assert from "node:assert/strict";
import {
  isConfidentEnglish,
  containsNonLatinScript,
  cleanNaturalLanguageText,
} from "../scripts/features/chat/language-detector.mjs";

// 1. Normal English responses
assert.equal(
  isConfidentEnglish("The system architecture provides scalable and reliable real-time messaging."),
  true,
  "Standard English sentence should be accepted"
);
assert.equal(
  isConfidentEnglish("Here is the updated explanation of the database index lifecycle and cache policy."),
  true,
  "Technical English explanation should be accepted"
);
assert.equal(
  isConfidentEnglish("You can easily customize the theme settings by opening the configuration panel."),
  true,
  "Conversational English instruction should be accepted"
);

// 2. English text containing code blocks, inline code, and URLs
assert.equal(
  isConfidentEnglish(
    "To solve this issue, run the following command in your terminal:\n```bash\nnpm install\n```\nLet me know if you need any additional help!"
  ),
  true,
  "English text with code blocks should be accepted"
);
assert.equal(
  isConfidentEnglish(
    "You can inspect the documentation at https://example.com/docs/api for complete details on configuration."
  ),
  true,
  "English text with URLs should be accepted"
);

// 3. Bengali script responses
assert.equal(
  isConfidentEnglish("আমি তোমাকে ভালোবাসি।"),
  false,
  "Bengali script text must be rejected"
);
assert.equal(
  containsNonLatinScript("আমি তোমাকে ভালোবাসি।"),
  true,
  "Bengali script should be detected"
);

// 4. Hindi script responses
assert.equal(
  isConfidentEnglish("नमस्ते, आप कैसे हैं? आशा है सब ठीक होगा।"),
  false,
  "Hindi script text must be rejected"
);
assert.equal(
  containsNonLatinScript("नमस्ते"),
  true,
  "Hindi script should be detected"
);

// 5. Romanized Bengali (Banglish) responses
assert.equal(
  isConfidentEnglish("Ami tomake bhalobashi"),
  false,
  "Banglish 'Ami tomake bhalobashi' must be rejected"
);
assert.equal(
  isConfidentEnglish("Tumi kemon acho"),
  false,
  "Banglish 'Tumi kemon acho' must be rejected"
);
assert.equal(
  isConfidentEnglish("Ei shomoy amader shobai ke eksathe thakte hobe."),
  false,
  "Banglish sentence must be rejected"
);

// 6. Romanized Hindi responses
assert.equal(
  isConfidentEnglish("Aap kaise hain bhai, sab theek hai na?"),
  false,
  "Romanized Hindi must be rejected"
);
assert.equal(
  isConfidentEnglish("Mera naam Rahul hai aur main theek hoon."),
  false,
  "Romanized Hindi self-intro must be rejected"
);

// 7. Mixed language responses
assert.equal(
  isConfidentEnglish("Hello friend, ami tomake bhalobashi so much!"),
  false,
  "Mixed English-Banglish must be rejected"
);
assert.equal(
  isConfidentEnglish("Good morning! Aap kaise hain today?"),
  false,
  "Mixed English-Hindi must be rejected"
);

// 8. Code-only and URL-only responses
assert.equal(
  isConfidentEnglish("```javascript\nconst x = 10;\nconsole.log(x);\n```"),
  false,
  "Pure code block without natural language must be rejected"
);
assert.equal(
  isConfidentEnglish("https://github.com/itshim998/SentIQGPT-backend/pull/42"),
  false,
  "Pure URL without natural language must be rejected"
);

// 9. Short ambiguous responses (fail closed)
assert.equal(
  isConfidentEnglish("OK"),
  false,
  "Short ambiguous message 'OK' must be rejected"
);
assert.equal(
  isConfidentEnglish("Yes, sure."),
  false,
  "Short phrase under length threshold must be rejected"
);
assert.equal(
  isConfidentEnglish("12345"),
  false,
  "Numeric text must be rejected"
);

console.log("Language detector regression tests passed.");
