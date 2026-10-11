"""Build a credential-free public plugin ZIP using only Python's standard library."""
import json
import re
from pathlib import Path
from urllib.parse import urlparse
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "plugin"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def https_url(value):
    url = urlparse(value)
    return url.scheme == "https" and bool(url.hostname) and not url.username and not url.password


def build():
    manifest = json.loads((SOURCE / "plugin.json").read_text())
    mcp = json.loads((SOURCE / "mcp.json").read_text())
    require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", manifest["name"]), "Invalid plugin name")
    require(len(manifest["name"]) <= 64, "Plugin name exceeds 64 characters")
    require(re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"]), "Use a release version such as 1.0.0")
    require(manifest["$schema"] == "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "Invalid plugin schema")
    require(mcp["$schema"] == "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "Invalid MCP schema")
    extension = manifest["extensions"]["com.openai"]
    require("apps" not in extension and "hooks" not in extension, "Public submission cannot include apps or hooks")
    interface = extension["interface"]
    for field, limit in [("displayName", 30), ("shortDescription", 30), ("longDescription", 4000), ("developerName", 80)]:
        value = interface[field]
        require(isinstance(value, str) and value.strip() and len(value) <= limit, f"Invalid {field}")
    for field in ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]:
        require(https_url(interface[field]) and len(interface[field]) <= 1024, f"Invalid {field}")
    prompts = interface["defaultPrompt"]
    require(isinstance(prompts, list) and 1 <= len(prompts) <= 3, "Provide 1–3 starter prompts")
    require(all(isinstance(p, str) and p.strip() and len(p) <= 128 for p in prompts), "Invalid starter prompt")
    require(len(mcp["mcpServers"]) == 1, "Public submission supports exactly one connected MCP server")
    for server in mcp["mcpServers"].values():
        require(server["type"] == "streamable-http" and https_url(server["url"]), "Use a public HTTPS MCP endpoint")
        require(not server.get("headers"), "Never bundle authentication headers")
    cases = extension["review"]["test_cases"]
    require(len(cases["positive"]) == 5 and len(cases["negative"]) == 3, "Include five positive and three negative cases")
    for kind, entries in cases.items():
        for case in entries:
            for field in ["description", "prompt", "expected_behavior"]:
                require(bool(case[field].strip()), f"Missing {field} in {kind} case")
            if kind == "positive":
                require(bool(case["tools_triggered"].strip()), "Positive cases must name expected tools")
    # Explicit allowlist: never zip the repository, .env, node_modules, or review notes.
    files = {"plugin.json", "mcp.json"}
    for field in ["composerIcon", "composerIconDark", "logo", "logoDark"]:
        if field not in interface:
            continue
        path = interface[field]
        require(path.startswith("./assets/") and ".." not in Path(path).parts, "Assets must stay inside plugin/assets")
        asset = SOURCE / path
        require(asset.resolve().is_relative_to(SOURCE.resolve()), "Asset escapes plugin root")
        require(asset.is_file() and asset.stat().st_size <= 5 * 1024 * 1024, "Missing or oversized asset")
        files.add(str(Path(path)))
    output = ROOT / "dist" / f'{manifest["name"]}-{manifest["version"]}.zip'
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for file in sorted(files):
            archive.write(SOURCE / file, file)
    with ZipFile(output) as archive:
        require(archive.testzip() is None, "Corrupt ZIP")
        require(set(archive.namelist()) == files, "Unexpected ZIP entries")
    print(f"Created {output}")
    if not extension["review"].get("demo_recording_url"):
        print("Before review: record the walkthrough and enter its accessible URL in the dashboard.")


if __name__ == "__main__":
    build()
