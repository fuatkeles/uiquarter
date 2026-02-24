import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface PrCommentOptions {
  readonly repo: string; // "owner/repo"
  readonly prNumber: number;
  readonly body: string;
  readonly update?: boolean;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const COMMENT_MARKER = "<!-- uiquarter-ci-report -->";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function isGhAvailable(): boolean {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function buildCommentBody(reportBody: string): string {
  return `${COMMENT_MARKER}\n${reportBody}`;
}

// -----------------------------------------------------------------------------
// PR comment posting
// -----------------------------------------------------------------------------

export async function postPrComment(options: PrCommentOptions): Promise<void> {
  if (!isGhAvailable()) {
    throw new Error(
      "GitHub CLI (gh) not found. Install it from https://cli.github.com/",
    );
  }

  const fullBody = buildCommentBody(options.body);

  // Write body to temp file (avoids shell escaping issues)
  const tempFile = join(tmpdir(), `uiq-pr-comment-${Date.now()}.md`);
  try {
    writeFileSync(tempFile, fullBody, "utf-8");

    if (options.update) {
      // Find existing comment and update it
      try {
        const commentsJson = execSync(
          `gh api repos/${options.repo}/issues/${options.prNumber}/comments --paginate`,
          { encoding: "utf-8" },
        );
        const comments = JSON.parse(commentsJson) as Array<{
          id: number;
          body: string;
        }>;
        const existing = comments.find((c) =>
          c.body.includes(COMMENT_MARKER),
        );
        if (existing) {
          execSync(
            `gh api repos/${options.repo}/issues/comments/${existing.id} -X PATCH -f body=@${tempFile}`,
          );
          return;
        }
      } catch {
        // Fall through to create new comment
      }
    }

    execSync(
      `gh pr comment ${options.prNumber} --repo ${options.repo} --body-file "${tempFile}"`,
    );
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      // Best effort cleanup
    }
  }
}
