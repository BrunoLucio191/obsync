import type { UserMutationResult } from "../../auth/auth.types.ts";
/**
 * Maps a failed {@link UserMutationResult} to the appropriate HTTP status code.
 * @param result - The mutation result to inspect.
 * @returns `200` if `result.ok` is `true`, otherwise a status code matching `result.reason`.
 */
export function mutationErrorStatus(result: UserMutationResult) {
  if (result.ok) return 200;

  switch (result.reason) {
    case "not_found":
      return 404;

    case "last_admin":
      return 409;

    case "invalid_role":
      return 400;

    case "name_exists":
      return 409;

    case "invalid_current_password":
      return 401;
  }
}

/**
 * Maps a failed {@link UserMutationResult} to a human-readable error message.
 * @param result - The mutation result to inspect.
 * @returns An empty string if `result.ok` is `true`, otherwise a message describing `result.reason`.
 */
export function mutationErrorMessage(result: UserMutationResult): string {
  if (result.ok) return "";

  switch (result.reason) {
    case "not_found":
      return "User not found.";

    case "last_admin":
      return "This operation would leave the platform without an active administrator.";

    case "invalid_role":
      return "Invalid user role.";

    case "name_exists":
      return "A user with that name already exists.";

    case "invalid_current_password":
      return "Incorrect current password.";
  }
}
