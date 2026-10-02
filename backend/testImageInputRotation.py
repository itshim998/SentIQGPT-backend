import sys
import unittest
from unittest.mock import patch, MagicMock

# Ensure project root is in sys.path
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import llm_adapter

class TestImageInputRotation(unittest.TestCase):
    def setUp(self):
        # Configure fake Gemini keys for testing rotation
        self.mock_records = [
            llm_adapter.GeminiKeyRecord(index=1, key="AIzaFakeKey1", env_name="GEMINI_API_KEY_1"),
            llm_adapter.GeminiKeyRecord(index=2, key="AIzaFakeKey2", env_name="GEMINI_API_KEY_2"),
            llm_adapter.GeminiKeyRecord(index=3, key="AIzaFakeKey3", env_name="GEMINI_API_KEY_3"),
        ]

    def test_gemini_image_input_success_on_first_key(self):
        items = [{"filename": "doc.png", "mime_type": "image/png", "image_base64": "AAAA", "page_number": 1}]
        fake_success_data = {
            "result": {
                "pages": [{"page_number": 1, "extracted_text": "Extracted OCR text", "visual_findings": ["Title: Header"]}],
                "request_evidence": {"relevant_text": "Extracted OCR text", "relevant_pages": [1]},
            },
            "input_tokens": 120,
            "output_tokens": 45,
            "raw_text": '{"pages": [{"page_number": 1, "extracted_text": "Extracted OCR text"}]}',
        }

        with patch.object(llm_adapter, "_get_round_robin_gemini_records", return_value=self.mock_records):
            with patch.object(llm_adapter, "_call_gemini_image_input", return_value=fake_success_data) as mock_call:
                res = llm_adapter._invoke_gemini_image_input(items, query="Read text", media_resolution="medium")
                self.assertEqual(res["key_slot"], 1)
                self.assertEqual(res["model_used"], "gemini-3.5-flash-lite")
                self.assertEqual(res["result"]["request_evidence"]["relevant_text"], "Extracted OCR text")
                self.assertEqual(mock_call.call_count, 1)

    def test_gemini_image_input_rotation_on_failure(self):
        """Scenario I: Key 1 fails -> automatically rotates to Key 2."""
        items = [{"filename": "doc.png", "mime_type": "image/png", "image_base64": "AAAA", "page_number": 1}]
        fake_success_data = {
            "result": {
                "pages": [{"page_number": 1, "extracted_text": "Rotated text", "visual_findings": []}],
                "request_evidence": {"relevant_text": "Rotated text", "relevant_pages": [1]},
            },
            "input_tokens": 100,
            "output_tokens": 30,
            "raw_text": '{"pages": []}',
        }

        def side_effect(items, query, media_res, api_key, model):
            if api_key == "AIzaFakeKey1":
                raise RuntimeError("503 Service Unavailable on Key 1")
            return fake_success_data

        with patch.object(llm_adapter, "_get_round_robin_gemini_records", return_value=self.mock_records):
            with patch.object(llm_adapter, "_call_gemini_image_input", side_effect=side_effect) as mock_call:
                res = llm_adapter._invoke_gemini_image_input(items, query="Read text")
                self.assertEqual(res["key_slot"], 2)
                self.assertEqual(res["result"]["request_evidence"]["relevant_text"], "Rotated text")
                self.assertEqual(mock_call.call_count, 2)

    def test_gemini_image_input_complete_failure(self):
        """Scenario J: All keys fail -> raises RuntimeError without fabricating OCR."""
        items = [{"filename": "doc.png", "mime_type": "image/png", "image_base64": "AAAA", "page_number": 1}]

        with patch.object(llm_adapter, "_get_round_robin_gemini_records", return_value=self.mock_records):
            with patch.object(llm_adapter, "_call_gemini_image_input", side_effect=RuntimeError("API quota exhausted")):
                with self.assertRaises(RuntimeError) as ctx:
                    llm_adapter._invoke_gemini_image_input(items, query="Read text")
                self.assertIn("All Gemini keys failed for image_input", str(ctx.exception))

    def test_parse_image_input_json_response_clean(self):
        items = [{"filename": "page1.png", "page_number": 1}]
        raw_json = '''```json
{
  "pages": [
    {
      "page_number": 1,
      "extracted_text": "Header line\\nBody line",
      "visual_findings": ["Table detected"],
      "quality": "good"
    }
  ],
  "request_evidence": {
    "relevant_text": "Header line\\nBody line",
    "relevant_pages": [1],
    "visual_findings": "Table detected"
  }
}
```'''
        parsed = llm_adapter._parse_image_input_json_response(raw_json, items)
        self.assertEqual(len(parsed["pages"]), 1)
        self.assertEqual(parsed["pages"][0]["extracted_text"], "Header line\nBody line")
        self.assertEqual(parsed["request_evidence"]["relevant_text"], "Header line\nBody line")

    def test_parse_image_input_fallback_when_invalid_json(self):
        items = [{"filename": "page1.png", "page_number": 1}]
        raw_text = "This is not valid json but raw OCR text."
        parsed = llm_adapter._parse_image_input_json_response(raw_text, items)
        self.assertEqual(len(parsed["pages"]), 1)
        self.assertIn("This is not valid json but raw OCR text.", parsed["pages"][0]["extracted_text"])
        self.assertIn("This is not valid json but raw OCR text.", parsed["request_evidence"]["relevant_text"])

if __name__ == "__main__":
    unittest.main()
