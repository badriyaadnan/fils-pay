# Multi-stage build of apps/settlement (the Go settlement service).
# بناء خدمة التسويات المكتوبة بلغة Go، على مرحلتين.
#
# Build context is the repo root.
# البناء يبدأ من المجلد الرئيسي للمشروع.
#
# Fix: this file was missing, so the settlement service could not be built.
# الإصلاح: هذا الملف كان ناقص، فخدمة التسويات ما كانت تنبني أبداً.

# Stage 1: compile the program.
# المرحلة 1: نترجم البرنامج.
FROM golang:1.24-alpine AS build

WORKDIR /src

# Download the libraries first so Docker can reuse them.
# نحمّل المكتبات أول عشان Docker يحفظها ويعيد استخدامها.
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download

COPY apps/settlement/ ./

# Static binary; Bahrain timezone data is built into it (time/tzdata).
# برنامج مستقل، وبيانات توقيت البحرين مدمجة داخله.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement \
 && go clean -cache

# Stage 2: a tiny image with only the compiled program.
# المرحلة 2: صورة صغيرة فيها البرنامج الجاهز بس.
FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/settlement /app/settlement
EXPOSE 8091
ENTRYPOINT []
CMD ["./settlement", "daemon"]