FROM nginx:stable-bookworm
# The file-serving worker uses the same UID as the file owners.
RUN groupmod --gid 10000 nginx && usermod --uid 10000 --gid 10000 nginx
