export const PROFILE_NAME_REQUIRED_EVENT = "sentiq:profile-name-required";

if (typeof window !== "undefined") {
  window.SentIQEvents = {
    ...(window.SentIQEvents || {}),
    PROFILE_NAME_REQUIRED_EVENT,
  };
}
