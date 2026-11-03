#!/usr/bin/env python3
"""One SAM 3.1 call on a fixture image; saves output_text for decoder tests."""
import json, sys, base64, urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response
FIX = "/home/hatch/workspace/hackathon-ar-creator/tools/sam-fixture"
img = "data:image/png;base64," + base64.b64encode(open(FIX + "/tanuki_opaque.png", "rb").read()).decode()
payload = {"model": "sam-3.1", "metadata": {"mask_encoding": "one_bit", "include_confidence": "true"},
           "input": [{"type": "message", "role": "user", "content": [
               {"type": "input_text", "text": "cartoon character"},
               {"type": "input_image", "image_url": img}]}]}
req = urllib.request.Request("https://api.meta.ai/v1/responses", data=json.dumps(payload).encode(),
                             headers={"Content-Type": "application/json"}, method="POST")
add_surrogate_to_request(req, "custom.meta-model-api", allowed_hosts=["api.meta.ai"])
with urllib.request.build_opener().open(req, timeout=300) as r:
    body = read_json_response(r)
txt = "".join(c.get("text", "") for item in body.get("output", []) for c in item.get("content", []))
open(FIX + "/sam_text.txt", "w").write(txt)
print("saved text len:", len(txt), "| usage:", json.dumps(body.get("usage", {})))
