import type { UserMutationResult } from "../../../../auth/auth.types.ts";
export function userMutationErrorStatus(result: UserMutationResult) {
  if (result.ok) {
    return 200;
  } else if (result.ok == false) {
    switch (result.reason) {
      case "NOT_FOUND":
        return 404;

      case "LAST_ADMIN":
        return 409;

      case "INVALID_ROLE":
        return 400;

      case "NAME_EXISTS":
        return 409;

      case "INVALID_CURRENT_PASSWORD":
        return 401;
    }
  }
}

export function UserMutationErrorMessage(result: UserMutationResult): string {
  if (result.ok) {
    return "";
  } else if (result.ok == false) {
    switch (result.reason) {
      case "NOT_FOUND":
        return "user not found.";

      case "LAST_ADMIN":
        return "this operation would leave the platform without an active administrator.";

      case "INVALID_ROLE":
        return "invalid user role.";

      case "NAME_EXISTS":
        return "a user with that name already exists.";

      case "INVALID_CURRENT_PASSWORD":
        return "incorrect current password.";
    }
  }
}
