import sys
import threading
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import docker_state


class DockerStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_state = docker_state.state
        docker_state.state = {
            "images": {
                "source:latest": {"exists": True, "labels": {}},
                "web:1": {"exists": True, "labels": {}},
            },
            "containers": {},
            "volumes": {},
            "networks": {},
            "fields": {},
        }
        self.workspace = tempfile.TemporaryDirectory()
        self.original_workspace = docker_state.WORKSPACE
        docker_state.WORKSPACE = Path(self.workspace.name)
        (docker_state.WORKSPACE / "Dockerfile").write_text(
            "FROM scratch\nLABEL owner=team-1\n"
        )
        (docker_state.WORKSPACE / "config.json").write_text("{}\n")

    def tearDown(self) -> None:
        docker_state.state = self.original_state
        docker_state.WORKSPACE = self.original_workspace
        self.workspace.cleanup()

    def test_build_and_tag_record_only_simulated_images(self) -> None:
        result = docker_state.apply(["build", "-t", "app:1", "."])
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(docker_state.state["fields"]["builtImage"], "app:1")
        self.assertEqual(docker_state.state["images"]["app:1"]["labels"]["owner"], "team-1")
        inspected = docker_state.apply(["image", "inspect", "app:1"])
        self.assertEqual(inspected["exitCode"], 0)
        self.assertEqual(docker_state.state["fields"]["inspectedImageOwner"], "team-1")

        result = docker_state.apply(["tag", "source:latest", "registry.test/app:1"])
        self.assertEqual(result["exitCode"], 0)
        self.assertTrue(docker_state.state["images"]["registry.test/app:1"]["exists"])

    def test_run_tracks_ports_mounts_network_and_resource_limits(self) -> None:
        docker_state.apply(["volume", "create", "data-1"])
        docker_state.apply(["network", "create", "app-net-1"])
        result = docker_state.apply([
            "run", "-d", "--name", "worker-1", "-p", "8101:80", "-p", "8201:443",
            "-v", "data-1:/var/lib/app", "--network", "app-net-1",
            "--memory", "512m", "--cpus", "0.5", "--restart",
            "unless-stopped", "web:1",
        ])
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(docker_state.state["fields"]["publishedPortPair"], "8101:80,8201:443")
        self.assertEqual(docker_state.state["fields"]["volumeMount"], "data-1:/var/lib/app")
        self.assertEqual(docker_state.state["fields"]["networkAttachment"], "worker-1@app-net-1")
        self.assertEqual(docker_state.state["fields"]["memoryLimit"], "512m")
        self.assertEqual(docker_state.state["fields"]["cpuLimit"], "0.5")
        self.assertEqual(docker_state.state["fields"]["resourceLimits"], "cpu=0.5,memory=512m")

    def test_simulator_rejects_unknown_images_and_build_contexts(self) -> None:
        missing_image = docker_state.apply(["run", "--name", "missing", "not-found:1"])
        unsafe_context = docker_state.apply(["build", "-t", "app:1", "../"])
        self.assertNotEqual(missing_image["exitCode"], 0)
        self.assertNotEqual(unsafe_context["exitCode"], 0)

    def test_container_lifecycle_and_copy_are_state_checked(self) -> None:
        docker_state.apply(["run", "--name", "web-1", "web:1"])
        docker_state.apply(["cp", "config.json", "web-1:/etc/app/config.json"])
        docker_state.apply(["stop", "web-1"])
        result = docker_state.apply(["rm", "web-1"])
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(docker_state.state["fields"]["removedContainer"], "web-1")
        docker_state.apply(["run", "--name", "cp-target", "web:1"])
        docker_state.apply(["cp", "config.json", "cp-target:/etc/app/config.json"])
        self.assertEqual(
            docker_state.state["fields"]["copiedFile"],
            "/etc/app/config.json=config.json",
        )
        escape = docker_state.apply(["cp", "../../etc/passwd", "cp-target:/etc/passwd"])
        self.assertNotEqual(escape["exitCode"], 0)
        inspected = docker_state.apply(["__inspect__"])
        self.assertNotIn("images", inspected["state"])

    def test_private_state_service_accepts_commands_and_returns_only_grading_fields(self) -> None:
        original_socket = docker_state.SOCKET_PATH
        docker_state.SOCKET_PATH = str(Path(self.workspace.name) / "docker.sock")
        server = docker_state.UnixServer(
            docker_state.SOCKET_PATH,
            docker_state.StateRequestHandler,
        )
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            created = docker_state.request(["volume", "create", "data-1"])
            inspected = docker_state.request(["__inspect__"])
            self.assertEqual(created["exitCode"], 0)
            self.assertEqual(inspected["state"]["fields"]["createdVolume"], "data-1")
            self.assertNotIn("images", inspected["state"])
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
            docker_state.SOCKET_PATH = original_socket


if __name__ == "__main__":
    unittest.main()
