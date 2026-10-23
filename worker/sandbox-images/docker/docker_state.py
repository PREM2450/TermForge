import json
import os
import re
import socket
import socketserver
import threading
from pathlib import Path
from typing import Any

SOCKET_PATH = "/run/termforge/docker.sock"
WORKSPACE = Path("/workspace")
MAX_STATE_ENTRIES = 256
IMAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$")
CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
OBJECT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
state: dict[str, Any] = {
    "images": {
        image: {"exists": True, "labels": {}}
        for image in (
            ["source:latest"]
            + [
                f"{name}:{number}"
                for name in (
                    "web", "api", "db", "worker", "cache", "service", "app",
                    "task", "daemon", "temporary", "gateway", "frontend",
                    "batch", "copy-target",
                )
                for number in range(1, 16)
            ]
        )
    },
    "containers": {},
    "volumes": {},
    "networks": {},
    "fields": {},
}
state_lock = threading.RLock()


def error(message: str) -> dict[str, Any]:
    return {"exitCode": 1, "output": f"docker: {message}\n"}


def parse_run(args: list[str]) -> dict[str, Any]:
    if not args:
        return error("run requires an image")
    result: dict[str, Any] = {
        "detached": False,
        "name": None,
        "ports": {},
        "mounts": {},
        "environment": {},
        "networks": {},
        "memoryLimit": None,
        "cpuLimit": None,
        "restartPolicy": None,
        "running": True,
        "exists": True,
        "files": {},
    }
    index = 0
    image = None
    while index < len(args):
        arg = args[index]
        if not arg.startswith("-"):
            image = arg
            break
        if arg in ("-d", "--detach"):
            result["detached"] = True
            index += 1
            continue
        if arg in ("--name", "-p", "--publish", "-v", "--volume", "--network", "--memory", "-m", "--cpus", "--restart", "-e", "--env"):
            index += 1
            if index >= len(args):
                return error(f"{arg} requires a value")
            value = args[index]
        elif arg.startswith("--name="):
            value = arg.partition("=")[2]
            arg = "--name"
        else:
            return error(f"unsupported run option {arg}")

        if arg == "--name":
            result["name"] = value
        elif arg in ("-p", "--publish"):
            if ":" not in value:
                return error("published ports must use host:container format")
            host, container = value.split(":", 1)
            if (
                not host.isdigit()
                or not container.split("/")[0].isdigit()
                or not 1 <= int(host) <= 65535
                or not 1 <= int(container.split("/")[0]) <= 65535
            ):
                return error("published ports must be numeric")
            result["ports"][host] = int(container.split("/")[0])
        elif arg in ("-v", "--volume"):
            segments = value.split(":")
            if len(segments) not in (2, 3):
                return error("mounts must use source:target[:ro]")
            source, target = segments[:2]
            result["mounts"][target] = {
                "source": source,
                "readOnly": len(segments) == 3 and segments[2] == "ro",
            }
        elif arg == "--network":
            result["network"] = value
        elif arg in ("--memory", "-m"):
            result["memoryLimit"] = value
        elif arg == "--cpus":
            result["cpuLimit"] = value
        elif arg == "--restart":
            result["restartPolicy"] = value
        elif arg in ("-e", "--env"):
            if "=" not in value:
                return error("environment variables must use NAME=value")
            key, content = value.split("=", 1)
            result["environment"][key] = content
        index += 1
    if image is None:
        return error("run requires an image")
    result["image"] = image
    return result


def apply(args: list[str]) -> dict[str, Any]:
    fields = state["fields"]
    if args == ["__inspect__"]:
        return {"exitCode": 0, "state": {"fields": dict(fields)}}
    if not args:
        return error("a command is required")
    command, rest = args[0], args[1:]
    if command == "build":
        tag = None
        context = None
        index = 0
        while index < len(rest):
            if rest[index] in ("-t", "--tag") and index + 1 < len(rest):
                tag = rest[index + 1]
                index += 2
            elif rest[index].startswith("--tag="):
                tag = rest[index].partition("=")[2]
                index += 1
            elif rest[index].startswith("-"):
                return error(f"unsupported build option {rest[index]}")
            else:
                context = rest[index]
                index += 1
        if not tag or context is None:
            return error("build requires -t TAG and a context")
        if not IMAGE_NAME.fullmatch(tag):
            return error("invalid image tag")
        if len(state["images"]) >= MAX_STATE_ENTRIES and tag not in state["images"]:
            return error("simulator image limit reached")
        if context not in (".", "./"):
            return error("the simulator only supports the current directory as build context")
        dockerfile = WORKSPACE / "Dockerfile"
        if not dockerfile.is_file():
            return error("Dockerfile not found in build context")
        if dockerfile.stat().st_size > 1024 * 1024:
            return error("Dockerfile exceeds the simulator size limit")
        labels = {}
        for line in dockerfile.read_text(errors="replace").splitlines():
            match = re.match(r"\s*LABEL\s+([A-Za-z0-9_.-]+)=(?:\"([^\"]*)\"|'([^']*)'|(\S+))", line)
            if match:
                label, *values = match.groups()
                value = next(value for value in values if value is not None)
                if len(labels) >= 32 or len(label) > 128 or len(value) > 512:
                    return error("image label exceeds simulator limits")
                labels[label] = value
        state["images"][tag] = {"exists": True, "labels": labels}
        fields["builtImage"] = tag
        return {"exitCode": 0, "output": f"Successfully built simulated image {tag}\n"}
    if command == "tag":
        if len(rest) != 2 or not state["images"].get(rest[0], {}).get("exists"):
            return error("tag requires an existing source image and a target tag")
        source, target = rest
        if not IMAGE_NAME.fullmatch(target):
            return error("invalid image tag")
        if len(state["images"]) >= MAX_STATE_ENTRIES and target not in state["images"]:
            return error("simulator image limit reached")
        state["images"][target] = {
            "exists": True,
            "labels": dict(state["images"][source].get("labels", {})),
        }
        fields["taggedImage"] = target
        return {"exitCode": 0, "output": f"Tagged {source} as {target}\n"}
    if command == "run":
        container = parse_run(rest)
        if "exitCode" in container:
            return container
        name = container["name"]
        if (
            not name
            or not CONTAINER_NAME.fullmatch(name)
            or name in state["containers"]
            or len(state["containers"]) >= MAX_STATE_ENTRIES
        ):
            return error("run requires a unique --name")
        if not state["images"].get(container["image"], {}).get("exists"):
            return error("image not found; build, pull, or tag it first")
        if not IMAGE_NAME.fullmatch(container["image"]):
            return error("invalid image name")
        for mount in container["mounts"].values():
            source = mount["source"]
            if not source.startswith(".") and source not in state["volumes"]:
                return error(f"volume not found: {source}")
        network = container.get("network")
        if network and network not in state["networks"]:
            return error(f"network not found: {network}")
        state["containers"][name] = container
        fields["namedContainer"] = name
        if container["detached"]:
            fields["detachedContainer"] = name
        for host, target in container["ports"].items():
            fields.setdefault("publishedPorts", {})[host] = target
        port_80 = next((host for host, target in container["ports"].items() if target == 80), None)
        port_443 = next((host for host, target in container["ports"].items() if target == 443), None)
        if port_80 and port_443:
            fields["publishedPortPair"] = f"{port_80}:80,{port_443}:443"
        for target, mount in container["mounts"].items():
            fields["volumeMount"] = f"{mount['source']}:{target}"
            if target == "/usr/share/site" and mount["readOnly"]:
                fields["readOnlyMount"] = True
        if container.get("network"):
            fields["networkAttachment"] = f"{name}@{container['network']}"
        if container.get("cpuLimit"):
            fields["cpuLimit"] = container["cpuLimit"]
        if container.get("memoryLimit"):
            fields["memoryLimit"] = container["memoryLimit"]
        if container.get("cpuLimit") and container.get("memoryLimit"):
            fields["resourceLimits"] = (
                f"cpu={container['cpuLimit']},memory={container['memoryLimit']}"
            )
        if container.get("restartPolicy"):
            fields["restartPolicy"] = container["restartPolicy"]
        if container["environment"]:
            fields["environment"] = dict(container["environment"])
        return {"exitCode": 0, "output": f"{name}\n"}
    if command == "volume" and len(rest) == 2 and rest[0] == "create":
        if not OBJECT_NAME.fullmatch(rest[1]):
            return error("invalid volume name")
        if len(state["volumes"]) >= MAX_STATE_ENTRIES:
            return error("simulator volume limit reached")
        state["volumes"][rest[1]] = True
        fields["createdVolume"] = rest[1]
        return {"exitCode": 0, "output": f"{rest[1]}\n"}
    if command == "network" and len(rest) == 2 and rest[0] == "create":
        if not OBJECT_NAME.fullmatch(rest[1]):
            return error("invalid network name")
        if len(state["networks"]) >= MAX_STATE_ENTRIES:
            return error("simulator network limit reached")
        state["networks"][rest[1]] = True
        fields["createdNetwork"] = rest[1]
        return {"exitCode": 0, "output": f"{rest[1]}\n"}
    if command == "rename" and len(rest) == 2:
        old, new = rest
        if not CONTAINER_NAME.fullmatch(new):
            return error("invalid container name")
        container = state["containers"].pop(old, None)
        if not container or new in state["containers"]:
            return error("rename requires an existing container and unused name")
        container["name"] = new
        state["containers"][new] = container
        fields["renamedContainer"] = new
        return {"exitCode": 0, "output": ""}
    if command == "stop" and len(rest) == 1:
        container = state["containers"].get(rest[0])
        if not container:
            return error("container not found")
        container["running"] = False
        fields["stoppedContainer"] = rest[0]
        return {"exitCode": 0, "output": rest[0] + "\n"}
    if command == "rm" and len(rest) == 1:
        container = state["containers"].pop(rest[0], None)
        if not container or container["running"]:
            return error("container must exist and be stopped before removal")
        fields["removedContainer"] = rest[0]
        return {"exitCode": 0, "output": rest[0] + "\n"}
    if command == "pull" and len(rest) == 1:
        if not IMAGE_NAME.fullmatch(rest[0]):
            return error("invalid image name")
        if len(state["images"]) >= MAX_STATE_ENTRIES and rest[0] not in state["images"]:
            return error("simulator image limit reached")
        state["images"][rest[0]] = {"exists": True, "labels": {}}
        return {"exitCode": 0, "output": f"Pulled simulated image {rest[0]}\n"}
    if command in ("rmi", "image") and rest:
        if command == "image" and len(rest) >= 1 and rest[0] == "inspect":
            image_names = rest[1:]
            if not image_names or any(not state["images"].get(name, {}).get("exists") for name in image_names):
                return error("image not found")
            for name in image_names:
                owner = state["images"][name].get("labels", {}).get("owner")
                if owner:
                    fields["inspectedImageOwner"] = owner
            return {"exitCode": 0, "output": json.dumps([state["images"][name] for name in image_names]) + "\n"}
        image_name = rest[0] if command == "rmi" else None
        if not image_name or not IMAGE_NAME.fullmatch(image_name) or not state["images"].get(image_name, {}).get("exists"):
            return error("image not found")
        state["images"][image_name]["exists"] = False
        fields["removedImage"] = image_name
        return {"exitCode": 0, "output": image_name + "\n"}
    if command == "cp" and len(rest) == 2:
        source, destination = rest
        if ":" not in destination:
            return error("copy destination must be CONTAINER:PATH")
        name, target = destination.split(":", 1)
        container = state["containers"].get(name)
        source_path = (WORKSPACE / source).resolve()
        if (
            not container
            or not source_path.is_relative_to(WORKSPACE.resolve())
            or not source_path.is_file()
            or not target.startswith("/")
        ):
            return error("copy requires an existing source file and container path")
        container["files"][target] = source_path.name
        state["fields"]["copiedFile"] = f"{target}={source_path.name}"
        return {"exitCode": 0, "output": ""}
    if command in ("images", "ps", "inspect", "version"):
        return {"exitCode": 0, "output": "TermForge Docker command simulator\n"}
    return error(f"unsupported simulated command: {command}")


class StateRequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        line = self.rfile.readline(8193)
        if not line or len(line) > 8192:
            response = {"exitCode": 1, "output": "request too large\n"}
        else:
            try:
                args = json.loads(line)
                if isinstance(args, list) and all(isinstance(arg, str) for arg in args):
                    with state_lock:
                        response = apply(args)
                else:
                    response = error("invalid request")
            except Exception:
                response = error("simulator could not process the request")
        self.wfile.write(json.dumps(response, separators=(",", ":")).encode() + b"\n")


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def start_server() -> None:
    os.makedirs(os.path.dirname(SOCKET_PATH), mode=0o755, exist_ok=True)
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass
    with UnixServer(SOCKET_PATH, StateRequestHandler) as server:
        os.chmod(SOCKET_PATH, 0o666)
        server.serve_forever()


def request(args: list[str]) -> dict[str, Any]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect(SOCKET_PATH)
        client.sendall(json.dumps(args, separators=(",", ":")).encode() + b"\n")
        response = b""
        while not response.endswith(b"\n"):
            chunk = client.recv(8192)
            if not chunk:
                break
            response += chunk
        result = json.loads(response)
    if not isinstance(result, dict):
        raise RuntimeError("invalid simulator response")
    return result


if __name__ == "__main__":
    start_server()
