export function mapAuthError(errorCode) {
  switch (errorCode) {
    case 'auth/invalid-credential':
      return 'Incorrect email or password.';
    case 'auth/user-not-found':
      return 'No account was found with this email or phone number.';
    case 'user_not_found':
      return 'No account was found with this email or phone number.';
    case 'auth/wrong-password':
      return 'Incorrect email or password.';
    case 'auth/email-already-in-use':
      return 'This email address is already registered.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/weak-password':
      return 'Password must be at least 6 characters long.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your internet connection.';
    case 'auth/requires-recent-login':
      return 'Please enter your password again to continue.';
    case 'auth/too-many-requests':
      return 'Too many failed login attempts. Please try again later.';
    case 'auth/phone-not-verified':
      return 'Please verify your phone number before creating an account.';
    case 'phone_not_verified':
      return 'Please verify your phone number before creating an account.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
