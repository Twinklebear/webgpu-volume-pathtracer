const M_PI: f32 = 3.14159265358979323846;

// Reduce clutter/keyboard pain
type float2 = vec2<f32>;
type float3 = vec3<f32>;
type float4 = vec4<f32>;
type uint2 = vec2<u32>;
type int2 = vec2<i32>;

// TODO: Would need to write a custom webpack loader for wgsl that
// processes #include to be able to #include this
struct LCGRand {
     state: u32,
};

fn murmur_hash3_mix(hash_in: u32, k_in: u32) -> u32
{
    let c1 = 0xcc9e2d51u;
    let c2 = 0x1b873593u;
    let r1 = 15u;
    let r2 = 13u;
    let m = 5u;
    let n = 0xe6546b64u;

    var k = k_in * c1;
    k = (k << r1) | (k >> (32u - r1));
    k *= c2;

    var hash = hash_in ^ k;
    hash = ((hash << r2) | (hash >> (32u - r2))) * m + n;

    return hash;
}

fn murmur_hash3_finalize(hash_in: u32) -> u32
{
    var hash = hash_in ^ (hash_in >> 16u);
    hash *= 0x85ebca6bu;
    hash ^= hash >> 13u;
    hash *= 0xc2b2ae35u;
    hash ^= hash >> 16u;

    return hash;
}

fn lcg_random(rng: ptr<function, LCGRand>) -> u32
{
    let m = 1664525u;
    let n = 1013904223u;
    // WGSL please Add an arrow operator or only use refs/inout
    // This is really a pain
    (*rng).state = (*rng).state * m + n;
    return (*rng).state;
}

fn lcg_randomf(rng: ptr<function, LCGRand>) -> f32
{
	return ldexp(f32(lcg_random(rng)), -32);
}

fn get_rng(frame_id: u32, pixel: int2, dims: int2) -> LCGRand
{
    var rng: LCGRand;
    rng.state = murmur_hash3_mix(0u, u32(pixel.x + pixel.y * dims.x));
    rng.state = murmur_hash3_mix(rng.state, frame_id);
    rng.state = murmur_hash3_finalize(rng.state);
    return rng;
}

struct VertexInput {
    @location(0) position: float3,
};

struct VertexOutput {
    @builtin(position) position: float4,
    @location(0) transformed_eye: float3,
    @location(1) ray_dir: float3,
};

struct ViewParams {
    proj_view: mat4x4<f32>,
    // Not sure on WGSL padding/alignment rules for blocks,
    // just assume align/pad to vec4
    eye_pos: float4,
    //volume_scale: float4;
    frame_id: u32,
};

// TODO: Become user params
var<private> sigma_t_scale: f32 = 100.0;
var<private> sigma_s_scale: f32 = 1.0;


@group(0) @binding(0)
var<uniform> view_params: ViewParams;

@group(0) @binding(1)
var volume: texture_3d<f32>;

@group(0) @binding(2)
var colormap: texture_2d<f32>;

@group(0) @binding(3)
var tex_sampler: sampler;

// Why can't we read from storage textures or read/write from one?
@group(0) @binding(4)
var accum_buffer_in: texture_2d<f32>;

@group(0) @binding(5)
var accum_buffer_out: texture_storage_2d<rgba32float, write>;

@vertex
fn vertex_main(vert: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    var pos = vert.position;
    out.position = view_params.proj_view * float4(pos, 1.0);
    out.transformed_eye = view_params.eye_pos.xyz;
    out.ray_dir = pos - out.transformed_eye;
    return out;
};

fn intersect_box(orig: float3, dir: float3) -> float2 {
	var box_min = float3(0.0);
	var box_max = float3(1.0);
	var inv_dir = 1.0 / dir;
	var tmin_tmp = (box_min - orig) * inv_dir;
	var tmax_tmp = (box_max - orig) * inv_dir;
	var tmin = min(tmin_tmp, tmax_tmp);
	var tmax = max(tmin_tmp, tmax_tmp);
	var t0 = max(tmin.x, max(tmin.y, tmin.z));
	var t1 = min(tmax.x, min(tmax.y, tmax.z));
	return float2(t0, t1);
}

fn sample_spherical_direction(s: float2) -> float3 {
    let cos_theta = 1.0 - 2.0 * s.x;
    let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));
    let phi = s.y * 2.0 * M_PI;
    return float3(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta);
}

fn linear_to_srgb(x: f32) -> f32 {
	if (x <= 0.0031308) {
		return 12.92 * x;
	}
	return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

struct SamplingResult {
    scattering_event: bool,
    color: float3,
    transmittance: f32,
};

fn sample_woodcock(orig: float3,
                   dir: float3,
                   interval: float2,
                   t: ptr<function, f32>,
                   rng: ptr<function, LCGRand>)
                   -> SamplingResult
{
    var result: SamplingResult;
    result.scattering_event = false;
    result.color = float3(0.0);
    result.transmittance = 0.0;
    loop {
        let samples = float2(lcg_randomf(rng), lcg_randomf(rng));

        *t -= log(1.0 - samples.x) / sigma_t_scale;
        if (*t >= interval.y) {
            break;
        }

        var p = orig + *t * dir;
        var val = textureSampleLevel(volume, tex_sampler, p, 0.0).r;
        // TODO: opacity from transfer function in UI instead of just based on the scalar value
        // Opacity values from the transfer fcn will already be in [0, 1]
        var density = val;
        //var sample_opacity = textureSampleLevel(colormap, tex_sampler, float2(val, 0.5), 0.0).a;
        // Here the sigma t scale will cancel out
        if (density > samples.y) {
            result.scattering_event = true;
            result.color = textureSampleLevel(colormap, tex_sampler, float2(val, 0.5), 0.0).rgb;
            result.transmittance = (1.0 - val);
            break;
        }
    }
    return result;
}

fn delta_tracking_transmittance(orig: float3,
                                dir: float3,
                                interval: float2,
                                rng: ptr<function, LCGRand>) -> f32
{
    var transmittance = 1.0;
    var t = interval.x;
    loop {
        let samples = float2(lcg_randomf(rng), lcg_randomf(rng));

        t -= log(1.0 - samples.x) / sigma_t_scale;
        if (t >= interval.y) {
            break;
        }

        var p = orig + t * dir;
        var val = textureSampleLevel(volume, tex_sampler, p, 0.0).r;
        // TODO: Sample opacity from colormap
        if (val > samples.y) {
            return 0.0;
        }
    }
    return 1.0;
}

fn ratio_tracking_transmittance(orig: float3,
                                dir: float3,
                                interval: float2,
                                rng: ptr<function, LCGRand>) -> f32
{
    var transmittance = 1.0;
    var t = interval.x;
    loop {
        t -= log(1.0 - lcg_randomf(rng)) / sigma_t_scale;
        if (t >= interval.y) {
            break;
        }

        var p = orig + t * dir;
        var val = textureSampleLevel(volume, tex_sampler, p, 0.0).r;
        // TODO: Sample from the opacity colormap
        transmittance *= (1.0 - val);
    }
    return transmittance;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) float4 {
    var ray_dir = normalize(in.ray_dir);

	var t_interval = intersect_box(in.transformed_eye, ray_dir);
	if (t_interval.x > t_interval.y) {
		discard;
	}
	t_interval.x = max(t_interval.x, 0.0);

    let pixel = int2(i32(in.position.x), i32(in.position.y));
    var rng = get_rng(view_params.frame_id, pixel, int2(1280, 720));

    // This should just be 1 for the max density in scivis
    var inv_max_density = 1.0;

    let light_dir = normalize(float3(1.0, 1.0, 0.0));
    let light_emission = 0.5;
    let ambient_strength = 0.0;
    let volume_emission = 0.5;

    var illum = float3(0.0);
    var throughput = float3(1.0);
    var transmittance = 1.0;

    var had_any_event = false;
    var pos = in.transformed_eye;
    // Sample the next scattering event in the volume
    for (var i = 0; i < 4; i += 1) {
        var t = t_interval.x;
        var event = sample_woodcock(pos, ray_dir, t_interval, &t, &rng);

        if (!event.scattering_event) {
            // Illuminate with an "environment light"
            if (had_any_event) {
                illum += throughput * float3(ambient_strength);
            } else {
                illum = float3(0.1);
            }
            break;
        } else {
            had_any_event = true;

            // Update scattered ray position
            pos = pos + ray_dir * t;

            // Sample illumination from the direct light
            t_interval = intersect_box(pos, light_dir);
            // We're inside the volume
            t_interval.x = 0.0;
            //var light_transmittance = ratio_tracking_transmittance(pos, light_dir, t_interval, &rng);
            var light_transmittance = delta_tracking_transmittance(pos, light_dir, t_interval, &rng);
            illum += throughput * light_transmittance * float3(light_emission);

            // Include emission from the volume for emission/absorption scivis model
            // Scaling the volume emission by the inverse of the opacity from the transfer function
            // can give some nice effects. Would be cool to provide control of this
            illum += throughput * event.color * volume_emission;// * (1.0 - event.transmittance);

            throughput *= event.color * event.transmittance * sigma_s_scale;

            // Scatter in a random direction to continue the ray
            ray_dir = sample_spherical_direction(float2(lcg_randomf(&rng), lcg_randomf(&rng)));
            t_interval = intersect_box(pos, ray_dir);
            if (t_interval.x > t_interval.y) {
                illum = float3(0.0, 1.0, 0.0);
                break;
            }
            // We're now inside the volume
            t_interval.x = 0.0;
        }
    }

    var color = float4(illum, 1.0);

    // Accumulate into the accumulation buffer for progressive accumulation 
    var accum_color = float4(0.0);
    if (view_params.frame_id > 0u) {
        accum_color = textureLoad(accum_buffer_in, pixel, 0);
    }
    accum_color += color;
    textureStore(accum_buffer_out, pixel, accum_color);

    color = accum_color / f32(view_params.frame_id + 1u);

    // TODO: background color also needs to be sRGB-mapped, otherwise this
    // causes the volume bounding box to show up incorrectly b/c of the
    // differing brightness
    color.r = linear_to_srgb(color.r);
    color.g = linear_to_srgb(color.g);
    color.b = linear_to_srgb(color.b);
    return color;
}

