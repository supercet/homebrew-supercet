class Supercet < Formula
  desc "Supercet - A Node.js application for git operations"
  homepage "https://github.com/supercet/homebrew-supercet"
  version "0.2.0"
  url "https://github.com/supercet/homebrew-supercet/releases/download/v0.2.0/supercet-arm64"
  sha256 "75e489eed06bfebd83c420bc6dcfa97892f3385afbb089114d238b44834fe289"
  license "MIT"

  on_arm do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.2.0/supercet-arm64"
    sha256 "75e489eed06bfebd83c420bc6dcfa97892f3385afbb089114d238b44834fe289"
  end

  on_intel do
    url "https://github.com/supercet/homebrew-supercet/releases/download/v0.2.0/supercet-x64"
    sha256 "2d84993457fedcfb68b45e19462d1caa87c7753368960ce149abe3abcb0b2cb3"
  end

  def install
    # Install the pre-compiled binary
    bin.install "supercet-#{Hardware::CPU.arm? ? "arm64" : "x64"}" => "supercet"
    chmod 0755, bin/"supercet"
  end

  livecheck do
    url :stable
    strategy :github_latest
  end

  test do
    # Test that the binary exists and is executable
    assert_predicate bin/"supercet", :exist?
    assert_predicate bin/"supercet", :executable?
    
    # Test that the command runs (even if it fails, it should not crash)
    system "#{bin}/supercet", "--help"
  end
end
