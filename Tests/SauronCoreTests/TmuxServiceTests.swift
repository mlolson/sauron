import Foundation
import Testing
@testable import SauronCore

@Suite struct TmuxServiceTests {
    @Test func sessionNameIsSafeAndPrefixed() {
        let id = UUID(uuidString: "ABCDEF12-0000-0000-0000-000000000000")!
        let name = TmuxService.sessionName(slug: "My Repo.v2", id: id)
        #expect(name == "sauron-my-repo-v2-abcdef12")
        #expect(!name.contains("."))
        #expect(!name.contains(":"))
    }

    @Test func newSessionArgumentsQuoteCommandAndSortEnv() {
        let args = TmuxService.newSessionArguments(
            name: "sauron-x-1",
            workingDir: "/tmp/repo",
            environment: ["ZED": "1", "ALPHA": "a b"],
            command: ["/usr/local/bin/claude", "--name", "it's here"]
        )
        #expect(args == [
            "new-session", "-d", "-s", "sauron-x-1", "-c", "/tmp/repo",
            "-e", "ALPHA=a b", "-e", "ZED=1",
            "/usr/local/bin/claude --name 'it'\\''s here'",
        ])
    }

    @Test func shellQuoteLeavesSafeWordsAlone() {
        #expect(TmuxService.shellQuote("--session-id=abc-123") == "--session-id=abc-123")
        #expect(TmuxService.shellQuote("") == "''")
        #expect(TmuxService.shellQuote("a b") == "'a b'")
    }

    @Test func attachUsesExactMatch() {
        #expect(TmuxService.attachArguments(name: "sauron-a-1") == ["attach-session", "-t", "=sauron-a-1:"])
    }
}

@Suite struct ClaudeTranscriptsTests {
    @Test func encodesPathLikeClaudeCode() {
        #expect(ClaudeTranscripts.encodeProjectPath("/Users/mattolson/code/sauron") == "-Users-mattolson-code-sauron")
        #expect(ClaudeTranscripts.encodeProjectPath("/a/b.c_d") == "-a-b-c-d")
    }

    @Test func transcriptURL() {
        let url = ClaudeTranscripts.transcriptURL(cwd: "/x/y", sessionId: "s1", home: URL(fileURLWithPath: "/home"))
        #expect(url.path == "/home/.claude/projects/-x-y/s1.jsonl")
    }
}

@Suite struct CLIResolverTests {
    @Test func findLocatesExecutable() {
        #expect(CLIResolver.find("ls", in: "/nonexistent:/bin") == "/bin/ls")
        #expect(CLIResolver.find("definitely-not-a-tool", in: "/bin") == nil)
    }

    @Test func loginShellPathContainsSystemBin() async {
        let path = await CLIResolver.loginShellPath()
        #expect(path.contains("/usr/bin"))
    }
}

@Suite struct ExternalCommandTests {
    @Test func capturesOutputAndExitCode() async throws {
        let result = try await ExternalCommand.run("/bin/sh", arguments: ["-c", "echo out; echo err 1>&2; exit 3"])
        #expect(result.stdout == "out\n")
        #expect(result.stderr == "err\n")
        #expect(result.exitCode == 3)
    }

    @Test func returnsEvenWhenAGrandchildKeepsOutputOpen() async throws {
        // A background child inherits stdout; a pipe-based implementation would hang here.
        let start = Date()
        let result = try await ExternalCommand.run("/bin/sh", arguments: ["-c", "(sleep 3 &) ; echo done"])
        #expect(result.stdout == "done\n")
        #expect(Date().timeIntervalSince(start) < 2)
    }

    @Test func checkThrowsOnFailure() async {
        await #expect(throws: SauronError.self) {
            try await ExternalCommand.check("/bin/sh", arguments: ["-c", "exit 1"])
        }
    }
}
